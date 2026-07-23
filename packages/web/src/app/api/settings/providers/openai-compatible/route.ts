import { NextResponse, after } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import {
  upsertOpenAiCompatibleProviderSchema,
  deleteOpenAiCompatibleSchema,
} from "@/lib/schemas/openai-compatible-provider";
import {
  createOrUpdateProvider,
  listOpenAiCompatibleProvidersForAdmin,
  deleteProviderById,
} from "@/lib/openai-compatible-providers";
import { getSetting, setSetting } from "@/lib/settings";
import { countConfiguredProviders } from "@/lib/provider-count";
import {
  buildRemainingCandidates,
  migrateAgentsOffDeletedProvider,
  repointAgentsOffRemovedModels,
  capMigratedAgents,
} from "@/lib/provider-deletion";
import { assertAllowedProviderUrl, ProviderUrlBlockedError } from "@/lib/provider-url-guard";
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
// that derives a `runtimeApplied` flag rather than 500-ing an already-persisted
// save (see setup/provider/route.ts + #880), `resetCache()`, and a
// `config.changed` audit whose detail snapshots `{ id, name }` and NEVER carries
// the API key or the full base URL (host only).

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
  const baseUrlHost = new URL(input.baseUrl).host;

  let row;
  try {
    row = await createOrUpdateProvider(input);
  } catch (err) {
    // The persist itself failed (e.g. slug-unique collision, DB error). Record
    // a failure audit that still avoids leaking the key, then surface a 500.
    recordAuditFailure(err, {
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      outcome: "failure",
      error: { message: err instanceof Error ? err.message : String(err) },
      detail: {
        // On an UPDATE the slug isn't derivable (it lives on the row the failing
        // call never returned), but `input.id` is in hand and is the only way an
        // analyst can correlate WHICH provider row failed to save. On a CREATE
        // there is no id yet, so snapshot the display name alone.
        ...(input.id
          ? { provider: { id: input.id, name: input.displayName } }
          : { provider: { name: input.displayName } }),
        authType: "openai-compatible",
        baseUrlHost,
        modelCount: input.models.length,
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
  // regenerate must NOT 500 (mirrors setup/provider/route.ts, #880). Record
  // whether it reached the runtime so the audit distinguishes saved vs applied.
  let runtimeApplied = true;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("Failed to apply OpenAI-compatible provider config to the runtime:", err);
    runtimeApplied = false;
  }
  resetCache();

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
        modelCount: row.models.length,
        runtimeApplied,
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
 * `keyHint` (last 4 chars) and NEVER the decrypted key.
 */
export const GET = withAdmin(async () => {
  // audit-exempt: read-only list, no state change. Uses the admin accessor so
  // each row carries a keyHint (the one decrypt path — see the module).
  const providers = await listOpenAiCompatibleProvidersForAdmin();
  return NextResponse.json(providers);
});

/**
 * Delete one custom OpenAI-compatible instance, migrating any agent pinned to
 * its models onto a remaining provider and reassigning `default_provider` when
 * the deleted slug was it. Mirrors the built-in provider DELETE verbatim: the
 * same last-provider guard shape (`countConfiguredProviders() <= 1` → 400), the
 * built-ins-first remaining-candidate ordering (Task 8), the shared
 * migration/reassignment/audit-diff helper, and a `settings.deleted` audit that
 * snapshots `{ id, name }`, caps the migrated-agent diff, and NEVER carries the
 * API key. Runtime apply is best-effort (`runtimeApplied`) — the row is already
 * gone, so a failed regenerate must not 500 (mirrors POST + #880).
 */
export const DELETE = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(deleteOpenAiCompatibleSchema, request);
  if ("error" in parsed) return parsed.error;
  const { id } = parsed.data;

  // A single custom instance counts as a valid sole provider, so this count
  // spans built-ins + custom instances (see provider-count.ts). Refuse to remove
  // the last one, with the exact status + message shape the built-in route uses.
  const totalConfigured = await countConfiguredProviders();
  if (totalConfigured <= 1) {
    return NextResponse.json(
      {
        error: "Cannot remove the last configured provider. Add another provider first.",
      },
      { status: 400 }
    );
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

    // Build the migration-target set EXCLUDING the just-deleted slug — already
    // gone from listOpenAiCompatibleProviders after deleteProviderById, so no
    // built-in exclusion is passed. Built-ins-first ordering + custom namespacing
    // are single-sourced in buildRemainingCandidates (shared with the built-in
    // DELETE route).
    const remainingCandidates = await buildRemainingCandidates();

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
  let runtimeApplied = true;
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("Failed to apply OpenAI-compatible provider deletion to the runtime:", err);
    runtimeApplied = false;
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
        runtimeApplied,
      },
    })
  );

  return NextResponse.json({
    ok: true,
    migratedAgents: migratedAgents.length,
    ...(newDefault !== undefined ? { newDefault } : {}),
  });
});
