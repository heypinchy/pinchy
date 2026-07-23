import { NextResponse, after } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { upsertOpenAiCompatibleProviderSchema } from "@/lib/schemas/openai-compatible-provider";
import {
  createOrUpdateProvider,
  listOpenAiCompatibleProviders,
} from "@/lib/openai-compatible-providers";
import { getSetting, setSetting } from "@/lib/settings";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
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
        provider: { name: input.displayName },
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
    }
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
  // audit-exempt: read-only list, no state change.
  const providers = await listOpenAiCompatibleProviders();
  return NextResponse.json(providers);
});
