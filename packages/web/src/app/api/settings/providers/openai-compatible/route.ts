import { NextResponse, after } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import {
  upsertOpenAiCompatibleProviderSchema,
  deleteOpenAiCompatibleSchema,
  type OpenAiCompatibleProviderRow,
} from "@/lib/schemas/openai-compatible-provider";
import {
  baseUrlDestinationChange,
  capForAudit,
  KEY_REQUIRED_FOR_NEW_DESTINATION,
  SECRET_REQUIRED_FOR_NEW_DESTINATION,
} from "@/lib/secret-destination";
import {
  createOrUpdateProvider,
  listOpenAiCompatibleProviders,
  listOpenAiCompatibleProvidersForAdmin,
  deleteProviderById,
  getProviderSnapshotById,
  decryptStoredKey,
  getModelsById,
  ProviderChangedError,
  ProviderNotFoundError,
} from "@/lib/openai-compatible-providers";
import { fetchOpenAiCompatibleModels } from "@/lib/openai-compatible-discovery";
import { DEFAULT_MODEL_CAPS, lookupModelCapabilities } from "@/lib/model-catalog";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";
import { getSetting, setSetting } from "@/lib/settings";
import { countConfiguredProviders } from "@/lib/provider-count";
import {
  buildRemainingCandidates,
  migrateAgentsOffDeletedProvider,
  repointAgentsOffRemovedModels,
  capMigratedAgents,
  LAST_CONFIGURED_PROVIDER_ERROR,
  noUsableTargetRefusal,
} from "@/lib/provider-deletion";
import { assertAllowedProviderUrl, ProviderUrlBlockedError } from "@/lib/provider-url-guard";
import { refusedBaseUrlReasons } from "@/lib/openai-compatible-stored-url";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { resolveModelForTemplate } from "@/lib/model-resolver";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver/types";
import { SMITHERS_MODEL_HINT } from "@/lib/personal-agent";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

// Generic "OpenAI-compatible" provider write/read routes (#894). Mirrors the
// built-in provider route's conventions verbatim: admin guard via `withAdmin`,
// `parseRequestBody` for structured 400s, best-effort `regenerateOpenClawConfig`
// that derives a `configRegenerated` flag rather than 500-ing an already-persisted
// save (see setup/provider/route.ts + #880), `resetCache()`, and a
// `config.changed` audit whose detail snapshots `{ id, name }` and NEVER carries
// the API key — the base URL appears as its host, plus origin + path when an
// update re-points it (never userinfo or query, each value capped by
// capForAudit). On every config.changed row of an EXISTING provider the `id` is
// its slug — the identity the other provider routes audit by — and the `name`
// is the stored one, so one filter finds a provider's whole history.
//
// #894 backend redesign: POST now DISCOVERS the model list itself (server-side
// `GET <baseUrl>/models`) instead of trusting the client's `models` array —
// see the schema's doc-comment. `manualModelIds` is the only client-supplied
// model input left, and it's used only when live discovery finds nothing.

/** Shown for an update whose provider does not exist (or no longer does). */
const PROVIDER_NOT_FOUND = "OpenAI-compatible provider not found.";

/** Shown when a save lost the compare-and-swap against a concurrent save. */
const PROVIDER_CHANGED_DURING_SAVE =
  "This provider changed while you were saving. Reload and try again.";

/**
 * Create (no `id`) or update (`id` present) an OpenAI-compatible provider.
 */
export const POST = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(upsertOpenAiCompatibleProviderSchema, request);
  if ("error" in parsed) return parsed.error;
  const input = parsed.data;

  // SSRF guard: the base URL is admin-supplied and OpenClaw fetches it at chat
  // time from the persisted config. Refuse to persist a reserved/internal/
  // metadata target (see provider-url-guard.ts) before it ever reaches
  // openclaw.json. Surface it inline on the baseUrl field (same shape as a Zod
  // field error) so the form can render it next to the input.
  try {
    await assertAllowedProviderUrl(input.baseUrl);
  } catch (err) {
    if (err instanceof ProviderUrlBlockedError) {
      return NextResponse.json(
        {
          error: "That base URL isn't allowed.",
          details: { formErrors: [], fieldErrors: { baseUrl: [err.message] } },
        },
        { status: 422 }
      );
    }
    throw err;
  }

  // Host-only, key-free audit detail — computed up front so the failure path
  // can reuse it. `new URL(baseUrl)` is safe: the schema already validated it.
  const baseUrlHost = capForAudit(new URL(input.baseUrl).host);

  // A stored key is bound to the base URL it was entered for (see
  // lib/secret-destination.ts). The admin UI never shows the key, so without
  // this an admin (or a stolen admin session) could point the base URL at a
  // host — or, on a shared gateway origin, a path — they control and receive
  // the key: as the Bearer token during discovery below, and on every later
  // chat. The SSRF guard cannot help: the attacker's host is public. So an
  // update that changes the base URL must bring a fresh key; the stored one is
  // never decrypted for it.
  //
  // The base URL and the key are read in ONE query, and that same snapshot is
  // the condition of the write below (see createOrUpdateProvider): a save only
  // lands on the row it was checked against, however long discovery takes.
  const stored = input.id ? await getProviderSnapshotById(input.id) : undefined;
  if (input.id && !stored) {
    // Nothing to change and nothing was sent anywhere, so no audit row.
    return NextResponse.json({ error: PROVIDER_NOT_FOUND }, { status: 404 });
  }
  const storedProvider = stored ? { id: stored.slug, name: stored.displayName } : undefined;
  const baseUrlChange = stored ? baseUrlDestinationChange(stored.baseUrl, input.baseUrl) : null;
  // The caller picks the URL, and with it the length of what lands in the audit row.
  const auditedBaseUrlChange = baseUrlChange
    ? { from: capForAudit(baseUrlChange.from), to: capForAudit(baseUrlChange.to) }
    : null;
  if (baseUrlChange && !input.apiKey) {
    // Refused before anything left the building, but still worth a row: a
    // repeated attempt to re-point a stored key is exactly what a CISO filters
    // the trail for. Nothing changed, so a plain awaited append fits.
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      outcome: "failure",
      error: { message: KEY_REQUIRED_FOR_NEW_DESTINATION },
      detail: {
        provider: storedProvider!,
        authType: "openai-compatible",
        reason: SECRET_REQUIRED_FOR_NEW_DESTINATION,
        baseUrlChange: auditedBaseUrlChange,
      },
    });
    return NextResponse.json(
      {
        error: KEY_REQUIRED_FOR_NEW_DESTINATION,
        details: { formErrors: [], fieldErrors: { apiKey: [KEY_REQUIRED_FOR_NEW_DESTINATION] } },
      },
      { status: 422 }
    );
  }

  // Server-side model discovery (#894 backend redesign). The effective key is
  // the freshly-supplied one, or — on an update that omitted it and kept the
  // same base URL — the stored, decrypted key: discovery must still hit the live
  // endpoint with SOME credential even when the admin didn't rotate it.
  // Undefined only on a CREATE with no apiKey, which createOrUpdateProvider
  // itself rejects below; discovery is simply skipped rather than probing with
  // no credential.
  const effectiveKey = input.apiKey ?? (stored ? decryptStoredKey(stored) : undefined);

  let models: OpenClawModelDefinition[] = effectiveKey
    ? await fetchOpenAiCompatibleModels(input.baseUrl, effectiveKey)
    : [];

  if (models.length === 0 && input.manualModelIds && input.manualModelIds.length > 0) {
    models = input.manualModelIds.map(
      (id) => lookupModelCapabilities(id) ?? { ...DEFAULT_MODEL_CAPS, id, name: id }
    );
  } else if (models.length === 0 && input.id) {
    // UPDATE with no fresh discovery and no manual fallback (e.g. a pure rename
    // while the endpoint is transiently down): keep the EXISTING snapshot rather
    // than blanking the column or blocking the save. The provider always has ≥1
    // model from create, so this preserves a usable list.
    models = (await getModelsById(input.id)) ?? [];
  } else if (models.length === 0 && effectiveKey) {
    // CREATE: discovery genuinely ran (we had a key) and found nothing, and
    // there's no manual fallback. Refuse to persist an inert new provider —
    // surfaced on `manualModelIds` so the form can render it next to that input.
    return NextResponse.json(
      {
        error: "No models found at this endpoint. Enter model ids manually.",
        details: {
          formErrors: [],
          fieldErrors: {
            manualModelIds: ["No models found at this endpoint. Enter model ids manually."],
          },
        },
      },
      { status: 422 }
    );
  }

  let row;
  try {
    // An update is conditioned on the snapshot it was checked against; a create
    // has none.
    row = stored
      ? await createOrUpdateProvider(input, models, stored)
      : await createOrUpdateProvider(input, models);
  } catch (err) {
    if (err instanceof ProviderChangedError) {
      // Another save changed the base URL or the key after this one was
      // checked — e.g. an admin re-entered the real key while this request's
      // discovery was held open by the host it names. Nothing was written, so a
      // plain awaited append fits, like the refusal above.
      await appendAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        outcome: "failure",
        error: { message: PROVIDER_CHANGED_DURING_SAVE },
        detail: {
          provider: storedProvider!,
          authType: "openai-compatible",
          reason: "provider_changed_during_save",
          baseUrlHost,
        },
      });
      return NextResponse.json({ error: PROVIDER_CHANGED_DURING_SAVE }, { status: 409 });
    }
    if (err instanceof ProviderNotFoundError) {
      // The row existed when it was checked and was deleted while discovery
      // ran. The answer is the same 404 an unknown id gets up front — but the
      // check had passed and a key may have gone to the endpoint, so unlike
      // that early 404 this one leaves a row.
      await appendAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        outcome: "failure",
        error: { message: PROVIDER_NOT_FOUND },
        detail: {
          provider: storedProvider!,
          authType: "openai-compatible",
          reason: "provider_deleted_during_save",
          baseUrlHost,
        },
      });
      return NextResponse.json({ error: PROVIDER_NOT_FOUND }, { status: 404 });
    }
    // The persist itself failed (e.g. slug-unique collision, DB error, or a
    // CREATE with no apiKey at all — see createOrUpdateProvider). Record a
    // failure audit that still avoids leaking the key, then surface a 500.
    recordAuditFailure(err, {
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      outcome: "failure",
      error: { message: err instanceof Error ? err.message : String(err) },
      detail: {
        // On an UPDATE the stored row was read before the write, so name it the
        // way every other row for this provider does (slug + stored name). On a
        // CREATE there is no row yet, so snapshot the display name alone.
        provider: storedProvider ?? { name: input.displayName },
        authType: "openai-compatible",
        baseUrlHost,
        modelCount: models.length,
      },
    });
    return NextResponse.json(
      { error: "Could not save the OpenAI-compatible provider." },
      { status: 500 }
    );
  }

  // Create-time default wiring: a freshly-created sole provider is only usable
  // if it's actually the default. Set `default_provider` to the new slug ONLY
  // when nothing is configured yet — never clobber an admin's existing default,
  // and never on an update (the slug already existed).
  if (!input.id) {
    const currentDefault = await getSetting("default_provider");
    if (currentDefault === null) {
      await setSetting("default_provider", row.slug, false);

      // First-provider seed repoint (mirrors setup/provider/route.ts): the
      // already-seeded Smithers agent still points at an unconfigured built-in
      // default (anthropic/…). Repoint it onto this sole custom instance's
      // resolved model — `resolveModelForTemplate` is slug-aware and yields
      // `<slug>/<modelId>` — so the UI shows the right model and the first chat
      // doesn't rely on OpenClaw's implicit fallback to the defaults model.
      const smithers = await db.query.agents.findFirst();
      if (smithers) {
        try {
          const resolved = await resolveModelForTemplate({
            hint: SMITHERS_MODEL_HINT,
            provider: row.slug,
          });
          await db.update(agents).set({ model: resolved.model }).where(eq(agents.id, smithers.id));
        } catch (err) {
          if (!(err instanceof TemplateCapabilityUnavailableError)) {
            throw err;
          }
          // Custom resolver shouldn't throw this, but stay symmetric with the
          // built-in route: keep the existing model on a capability mismatch.
        }
      }
    }
  }

  // On UPDATE the admin may have DROPPED a model that agents were pinned to.
  // Repoint those agents onto a still-present model of the SAME provider so they
  // don't dangle on a `<slug>/<removed-id>` that's no longer emitted into
  // openclaw.json and would fail at chat time. Mirrors the delete route's
  // migration; the provider still has ≥1 model (schema `.min(1)`). A CREATE
  // can't orphan anything, so this only runs for updates.
  let migratedAgents: Awaited<ReturnType<typeof repointAgentsOffRemovedModels>> = [];
  if (input.id) {
    migratedAgents = await repointAgentsOffRemovedModels({
      slug: row.slug,
      keptModelIds: row.models.map((m) => m.id),
    });
  }

  // Best-effort runtime apply: the row is already committed, so a failed
  // regenerate must NOT 500 (mirrors setup/provider/route.ts, #880). The
  // audited flag asserts only that the regenerate did not throw — the push
  // itself is fire-and-forget, so it is deliberately NOT named
  // `runtimeApplied` (see setup/provider, #943).
  //
  // The model cache is cleared FIRST: the regenerate resolves this provider's
  // live model list, and must not be served the list cached before the save —
  // for a re-pointed provider that is the OLD endpoint's catalog.
  resetCache();
  let configRegenerated = true;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("Failed to apply OpenAI-compatible provider config to the runtime:", err);
    configRegenerated = false;
  }

  // Cap the migrated-agent list so audit's 2KB truncateDetail can't shred the
  // structured fields (same rationale as the delete route).
  const { inlineMigrated, truncated } = capMigratedAgents(migratedAgents);

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      outcome: "success",
      detail: {
        provider: { id: row.slug, name: row.displayName },
        authType: "openai-compatible",
        baseUrlHost,
        // `baseUrlChange` is only present when an update moved the provider to a
        // new base URL (origin + path, never userinfo or query — either can carry
        // a credential), so an analyst can see where a key was re-pointed.
        ...(auditedBaseUrlChange ? { baseUrlChange: auditedBaseUrlChange } : {}),
        modelCount: row.models.length,
        configRegenerated,
        // Only present when an edit actually repointed agents off removed models.
        ...(migratedAgents.length > 0
          ? {
              agentCount: migratedAgents.length,
              migratedAgents: inlineMigrated,
              ...(truncated ? { migratedAgentsTruncated: true } : {}),
            }
          : {}),
      },
    })
  );

  return NextResponse.json(row);
});

/**
 * List every configured OpenAI-compatible provider. Each row carries a
 * `keyHint` (last 4 chars) and NEVER the decrypted key, plus `refusedReason`:
 * why the SSRF guard now refuses the saved base URL (config emission points
 * such a provider at a reserved address — see openai-compatible-stored-url.ts),
 * or `null`. Each host is looked up once per request, with a short timeout.
 */
export const GET = withAdmin(async () => {
  // Read-only list, no state change — GET is outside require-audit-log's scope
  // (it only checks POST/PUT/PATCH/DELETE), so no audit call is needed here.
  // Uses the admin accessor so each row carries a keyHint (the one decrypt
  // path — see the module).
  const providers = await listOpenAiCompatibleProvidersForAdmin();
  const refused = await refusedBaseUrlReasons(providers);
  const rows: OpenAiCompatibleProviderRow[] = providers.map((p) => ({
    ...p,
    refusedReason: refused.get(p.slug) ?? null,
  }));
  return NextResponse.json(rows);
});

/**
 * Delete one custom OpenAI-compatible instance, migrating any agent pinned to
 * its models onto a remaining provider and reassigning `default_provider` when
 * the deleted slug was it. Mirrors the built-in provider DELETE verbatim: the
 * same last-provider guard shape (`countConfiguredProviders() <= 1` → 400), the
 * same "no usable provider would remain" refusal, the built-ins-first
 * remaining-candidate ordering (Task 8, refused base URLs left out), the shared
 * migration/reassignment/audit-diff helper, and a `settings.deleted` audit that
 * snapshots `{ id, name }`, caps the migrated-agent diff, and NEVER carries the
 * API key. Runtime apply is best-effort (`configRegenerated`) — the row is already
 * gone, so a failed regenerate must not 500 (mirrors POST + #880).
 */
export const DELETE = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(deleteOpenAiCompatibleSchema, request);
  if ("error" in parsed) return parsed.error;
  const { id } = parsed.data;

  // An unknown id is a 404 before any guard: otherwise a stale id would be
  // answered — and audited — as a refused removal of a provider that does not
  // exist. Same answer, and no audit, as the race below where the row vanishes
  // between this lookup and the delete.
  const row = (await listOpenAiCompatibleProviders()).find((p) => p.id === id);
  if (!row) {
    return NextResponse.json({ error: "OpenAI-compatible provider not found." }, { status: 404 });
  }

  // A single custom instance counts as a valid sole provider, so this count
  // spans built-ins + custom instances (see provider-count.ts). Refuse to remove
  // the last one, with the exact status + message shape the built-in route uses.
  const totalConfigured = await countConfiguredProviders();
  if (totalConfigured <= 1) {
    return NextResponse.json({ error: LAST_CONFIGURED_PROVIDER_ERROR }, { status: 400 });
  }

  // Build the migration-target set BEFORE deleting, excluding this row by id:
  // it doubles as the "is a usable provider left?" guard, which is worthless
  // once the row is gone. Built-ins-first ordering, custom namespacing, and
  // leaving out custom providers whose base URL is refused are single-sourced
  // in buildRemainingCandidates (shared with the built-in DELETE route).
  const remainingCandidates = await buildRemainingCandidates({ excludeCustomId: id });
  if (remainingCandidates.length === 0) {
    // The refusal comes from the SSRF guard's verdict on the other providers,
    // so it is recorded like PATCH /default's refusal. No address in it. Its
    // wording (and `reason`) depends on whether this provider is refused too.
    const refusal = await noUsableTargetRefusal(row);
    after(() =>
      appendAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        outcome: "failure",
        detail: {
          action: "provider_delete_refused_no_usable_target",
          reason: refusal.reason,
          // Keyed by slug like every other config.changed row about an
          // existing provider (see the header), not by the row UUID.
          provider: { id: row.slug, name: row.displayName },
        },
      })
    );
    return NextResponse.json({ error: refusal.error }, { status: 400 });
  }

  let deleted: Awaited<ReturnType<typeof deleteProviderById>> = null;
  let wasDefault = false;
  let migratedAgents: Awaited<
    ReturnType<typeof migrateAgentsOffDeletedProvider>
  >["migratedAgents"] = [];
  let newDefault: string | undefined;

  try {
    deleted = await deleteProviderById(id);
    if (!deleted) {
      return NextResponse.json({ error: "OpenAI-compatible provider not found." }, { status: 404 });
    }

    const previousDefault = await getSetting("default_provider");
    wasDefault = previousDefault === deleted.slug;

    ({ migratedAgents, newDefault } = await migrateAgentsOffDeletedProvider({
      deletedPrefix: `${deleted.slug}/`,
      remainingCandidates,
      wasDefault,
    }));
  } catch (err) {
    // The delete/migration itself failed mid-flight. This flow is deliberately
    // NOT transactional: the row is already deleted and agents may be only
    // partially migrated. A retry is safe — re-running against the now-missing
    // prefix migrates whatever remains, and the last-provider guard above
    // prevents ever deleting the sole provider (so orphaned agents always have a
    // target). Record a failure audit that still snapshots the provider name for
    // post-mortem correlation, then 500.
    recordAuditFailure(err, {
      actorType: "user",
      actorId: session.user.id!,
      eventType: "settings.deleted",
      resource: `settings:provider:${deleted?.slug ?? id}`,
      outcome: "failure",
      error: { message: err instanceof Error ? err.message : String(err) },
      detail: {
        name: deleted?.displayName ?? id,
        provider: deleted ? { id: deleted.id, name: deleted.displayName } : { id },
        ...(deleted ? { slug: deleted.slug } : {}),
      },
    });
    return NextResponse.json(
      { error: "Could not delete the OpenAI-compatible provider." },
      { status: 500 }
    );
  }

  // Best-effort runtime apply: the row is already gone, so a failed regenerate
  // must NOT 500 (mirrors POST + #880). Record whether it reached the runtime.
  let configRegenerated = true;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("Failed to apply OpenAI-compatible provider deletion to the runtime:", err);
    configRegenerated = false;
  }
  resetCache();

  const { inlineMigrated, truncated } = capMigratedAgents(migratedAgents);

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "settings.deleted",
      resource: `settings:provider:${deleted!.slug}`,
      outcome: "success",
      detail: {
        // Snapshot {id,name} + slug: the row is gone and can't be queried later.
        name: deleted!.displayName,
        provider: { id: deleted!.id, name: deleted!.displayName },
        slug: deleted!.slug,
        wasDefault,
        ...(newDefault !== undefined ? { newDefault } : {}),
        agentCount: migratedAgents.length,
        migratedAgents: inlineMigrated,
        ...(truncated ? { migratedAgentsTruncated: true } : {}),
        configRegenerated,
      },
    })
  );

  return NextResponse.json({
    ok: true,
    migratedAgents: migratedAgents.length,
    ...(newDefault !== undefined ? { newDefault } : {}),
  });
});
