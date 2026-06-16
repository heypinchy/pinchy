// Canonical OpenClaw transport defaults for Pinchy's built-in cloud providers.
//
// Extracted from build.ts so the emission loop in `regenerateOpenClawConfig`
// reads as orchestration while these provider-specific constants live in one
// self-describing place. Pure data — no imports, no side effects.

// OC 2026.4.27+ requires `baseUrl` in `models.providers.<name>` for every configured
// built-in provider — startup config validation rejects the file otherwise. We write
// SDK-canonical defaults; proxy/test deployments override via env-vars.
// Verified against openclaw@2026.4.27 dist on 2026-05-06.
//
// These are BARE HOSTS (no path suffix). The path suffix is appended at
// emission time via `BUILTIN_PROVIDER_PATH_SUFFIX` so PINCHY_PROVIDER_BASEURL_*
// overrides (which carry only the host) get the same suffix treatment. The
// SDK env-var path (*_BASE_URL) takes precedence with its value verbatim — see
// the emission loop in build.ts for the layering rules.
export const BUILTIN_PROVIDER_DEFAULT_BASE_URLS: Record<"anthropic" | "openai" | "google", string> =
  {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
    google: "https://generativelanguage.googleapis.com",
  };

// OC's per-provider path conventions. Appended to the bare host above to
// produce the `baseUrl` that lands in openclaw.json. Anthropic exposes its API
// at the root; OpenAI lives under /v1; Google's Generative Language API lives
// under /v1beta. Locked against the existing SDK-env-var tests at
// openclaw-config.test.ts:734-822, which assert the final emitted URLs.
export const BUILTIN_PROVIDER_PATH_SUFFIX: Record<"anthropic" | "openai" | "google", string> = {
  anthropic: "",
  openai: "/v1",
  google: "/v1beta",
};

export const BUILTIN_PROVIDER_BASE_URL_ENV_VARS: Record<"anthropic" | "openai" | "google", string> =
  {
    anthropic: "ANTHROPIC_BASE_URL",
    openai: "OPENAI_BASE_URL",
    google: "GOOGLE_BASE_URL",
  };

// OC's transport `api` per built-in provider. We emit this explicitly so the
// generated openclaw.json is self-describing and never depends on OpenClaw's
// implicit api inference.
//
// OpenClaw 2026.5.28 changed `resolveConfiguredProviderDefaultApi`: a provider
// with a `baseUrl` and no explicit `api` now falls back to "openai-completions"
// instead of being inferred from the provider name. That silently broke the
// built-in google provider — OC POSTed `<baseUrl>/chat/completions` instead of
// the native Gemini `:generateContent`, so chat failed with a FailoverError
// ("provider returned an HTML error page"). anthropic/openai only kept working
// because their model ids still matched OC's catalog discovery, which is the
// same latent fragility.
//
// `openai` uses the Chat Completions API (`openai-completions`), NOT the newer
// Responses API (`openai-responses`) that OC's own catalog defaults to. Reason:
// the built-in `openai` provider accepts an `OPENAI_BASE_URL` override for
// OpenAI-compatible proxy customers (vLLM, LiteLLM, gateways), and those
// proxies broadly implement `/v1/chat/completions` but frequently NOT
// `/v1/responses`. Chat Completions is the maximally-compatible surface and
// fully covers Pinchy's chat + tools + vision needs against real OpenAI too.
export const BUILTIN_PROVIDER_API: Record<"anthropic" | "openai" | "google", string> = {
  anthropic: "anthropic-messages",
  openai: "openai-completions",
  google: "google-generative-ai",
};
