// Pre-flight validation of Microsoft OAuth app config, run at "save settings"
// time so a misconfiguration surfaces as an inline field error instead of a
// dead-end on Microsoft's own error page. AADSTS90002 (tenant not found) is a
// pre-authorize error that never redirects back to our callback, so it can
// only be PREVENTED here, not caught later. See docs/plans/2026-07-03-oauth-
// lifecycle-hardening.md.
//
// The single import here is deliberate: insecure-mock-base-url.ts has no
// imports of its own, so this module stays client-safe and oauth-providers.ts
// (a Client Component dependency) can keep importing it.
import { resolveInsecureMockBaseUrl } from "@/lib/integrations/insecure-mock-base-url";

const WELL_KNOWN_TENANTS = new Set(["organizations", "common", "consumers"]);

// Matches the timeout convention used by the other third-party probes in this
// codebase (brave-probe.ts, providers.ts' PROVIDER_PROBE_TIMEOUT_MS) — an
// AbortSignal timeout rejects fetch(), which the catch below turns into the
// same fail-open "unknown" result as any other network error.
const TENANT_PROBE_TIMEOUT_MS = 10_000;

// network/other — caller should fail-open
export type TenantValidation =
  { ok: true } | { ok: false; reason: "not_found" } | { ok: "unknown" };

export async function validateMicrosoftTenant(tenantId: string): Promise<TenantValidation> {
  const t = tenantId.trim();
  if (t.length === 0 || WELL_KNOWN_TENANTS.has(t.toLowerCase())) return { ok: true };
  // Honoured only alongside PINCHY_INSECURE_MAIL_MOCK=1, same as every other
  // mock redirect on the web side — see insecure-mock-base-url.ts.
  const host =
    resolveInsecureMockBaseUrl("MICROSOFT_OAUTH_BASE_URL") || "https://login.microsoftonline.com";
  try {
    const res = await fetch(
      `${host}/${encodeURIComponent(t)}/v2.0/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(TENANT_PROBE_TIMEOUT_MS) }
    );
    if (res.ok) return { ok: true };
    if (res.status === 400) return { ok: false, reason: "not_found" };
    return { ok: "unknown" }; // 5xx etc. — don't block on a transient upstream problem
  } catch {
    return { ok: "unknown" }; // network error or timeout — fail-open
  }
}
