import type { SecretsBundle } from "@/lib/openclaw-secrets";

// Central assembly point for the runtime SecretsBundle written to
// secrets.json. Build inputs are collected during config generation in
// `build.ts`; this helper just packages them. Centralized so the
// secrets-handling pattern matrix from CLAUDE.md (Pattern A: SecretRef-
// resolved provider keys & env templates, Pattern B: API-fetched
// per-integration creds, Pattern C: bootstrap gateway/plugin tokens
// written plain) has a single home — future audit, rotation, or
// validation logic can land here without re-touching `build.ts`.

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
