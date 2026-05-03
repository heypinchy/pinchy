import { readSecretsFile, type SecretsBundle } from "@/lib/openclaw-secrets";
import { PROVIDERS } from "@/lib/providers";
import { getSetting } from "@/lib/settings";

// Central home for the runtime-secret pipeline that feeds openclaw.json
// + secrets.json. Owns the Pattern A/B/C secret-handling matrix from
// CLAUDE.md "Secrets Handling":
//
//   Pattern A — OpenClaw built-in resolves SecretRef
//     LLM provider apiKey, env-template `${VAR}` strings.
//     `collectProviderSecrets()` walks PROVIDERS for configured keys
//     and produces all three sides of the link in one place
//     (env.* template, providers.* secret, env.* resolved value).
//
//   Pattern B — Pinchy plugins fetch via API
//     Per-integration credentials (Odoo, web-search, email).
//     Not collected here — the plugin reads `connectionId` from
//     openclaw.json and calls /api/internal/integrations/.../credentials
//     at runtime. See pinchy-odoo / pinchy-email / pinchy-web.
//
//   Pattern C — Bootstrap credentials (plaintext, single source)
//     Gateway auth token and plugin gatewayToken values.
//     `readGatewayTokenFromConfig()` extracts the token from existing
//     openclaw.json (preferred) or secrets.json (fallback). Cannot
//     itself be fetched via Pinchy's API (chicken-and-egg).
//
// Future audit, rotation, and validation logic for any of these
// patterns belongs in this file.

export interface ProviderSecretsCollection {
  /** `${VAR}` templates for `env.*` in openclaw.json. */
  envTemplates: Record<string, string>;
  /** Per-provider apiKey for `secrets.json#/providers`. */
  providers: Record<string, { apiKey: string }>;
  /** Resolved env-var values for `secrets.json#/env`. */
  envSecrets: Record<string, string>;
}

/**
 * Walk PROVIDERS for configured API keys and produce the secrets-bundle
 * pair (Pattern A from CLAUDE.md "Secrets Handling").
 *
 * For each provider with an apiKey set in settings AND an `envVar`
 * declared in PROVIDERS, emits:
 *   - providers.<providerKey> = { apiKey }   (into secrets.json)
 *   - env.<envVar> = <apiKey>      (into secrets.json — kept for
 *     start-openclaw.sh backward-compat until Phase 2.4 removes the
 *     bash watch loop)
 *
 * NOTE: envTemplates is intentionally empty. Provider API keys now use
 * SecretRef in models.providers.<name>.apiKey (build.ts) instead of
 * `${VAR}` templates in openclaw.json's env block. The env-template
 * approach required shell `export` + process restart on key rotation;
 * SecretRef resolves live from secrets.json without a restart.
 *
 * Returns fresh, mutable maps owned by the caller. The caller may
 * splice in additional entries (e.g. ollama-cloud, handled at the
 * model-providers call site in build.ts).
 */
export async function collectProviderSecrets(): Promise<ProviderSecretsCollection> {
  const envTemplates: Record<string, string> = {};
  const providers: Record<string, { apiKey: string }> = {};
  const envSecrets: Record<string, string> = {};
  for (const [providerKey, providerConfig] of Object.entries(PROVIDERS)) {
    const apiKey = await getSetting(providerConfig.settingsKey);
    if (apiKey && providerConfig.envVar) {
      providers[providerKey] = { apiKey };
      envSecrets[providerConfig.envVar] = apiKey;
    }
  }
  return { envTemplates, providers, envSecrets };
}

/**
 * Extract the gateway auth token (Pattern C) from existing openclaw.json,
 * falling back to secrets.json.
 *
 * The gateway token is a bootstrap credential — it must be a literal
 * string in `gateway.auth.token` (OpenClaw refuses SecretRef objects in
 * that path) and is also mirrored to `secrets.json#/gateway/token` so
 * Pinchy can read it for its own outbound RPCs. The two sources are
 * kept in sync by `regenerateOpenClawConfig` writing both on every pass.
 *
 * Returns undefined when neither source has the token (cold start
 * before `ensure-gateway-token.js` provisions it, or a broken OpenClaw
 * container). Callers should warn and emit an empty-token gateway block
 * so a fresh setup self-heals on the next regenerate pass.
 *
 * Behavioural note: the existing-config path uses `typeof === "string"`
 * (rather than truthy-check) so an empty-string token in existing config
 * is preserved as-is and does NOT silently fall through to secrets.json.
 * That distinguishes "OpenClaw wrote an empty token" (a state worth
 * surfacing via the warning) from "no existing config" (cold start).
 */
export function readGatewayTokenFromConfig(existing: Record<string, unknown>): string | undefined {
  const existingGateway = (existing.gateway as Record<string, unknown>) || {};
  const existingAuth = (existingGateway.auth as Record<string, unknown>) || {};
  return typeof existingAuth.token === "string"
    ? existingAuth.token
    : readSecretsFile().gateway?.token;
}

/**
 * Assemble the runtime SecretsBundle written to secrets.json.
 *
 * Each input is collected upstream during config building:
 *   - gateway:      Pattern C bootstrap token (readGatewayTokenFromConfig)
 *   - providers:    Pattern A LLM-provider keys (collectProviderSecrets)
 *   - integrations: Pattern B placeholder (live integrations fetch via
 *                   /api/internal/integrations/.../credentials)
 *   - env:          Pattern A resolved env-var values (collectProviderSecrets)
 */
export function buildSecretsBundle(parts: {
  gateway: SecretsBundle["gateway"];
  providers: SecretsBundle["providers"];
  integrations: SecretsBundle["integrations"];
  env: SecretsBundle["env"];
}): SecretsBundle {
  return {
    gateway: parts.gateway,
    providers: parts.providers,
    integrations: parts.integrations,
    env: parts.env,
  };
}
