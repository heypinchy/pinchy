import {
  TRANSIENT_PATTERN,
  PROVIDER_CONFIG_PATTERN,
  PROVIDER_REJECTED_GENERIC_PATTERN,
  isThoughtSignatureRejection,
  CONTEXT_OVERFLOW_PATTERN,
} from "@/server/error-patterns";

export const PROVIDER_SETTINGS_HINT = "Go to Settings > Providers to check your API configuration.";

// User-facing replacement for OpenClaw's generic provider-rejection envelope
// (#584). The raw wording — "provider rejected the request schema or tool
// payload" — reads like a malformed-request bug; the real cause (most often a
// provider-account issue: billing, API key, quota) is collapsed by OpenClaw and
// never reaches Pinchy in the chunk text. This honest message points an admin at
// the provider-account cause family without asserting a specific cause. Only the
// banner uses this; the audit trail keeps the raw text.
export const PROVIDER_REJECTED_GENERIC_MESSAGE =
  "The AI provider rejected the request. This is often a provider-account issue (billing, API key, or quota) — check Settings > Providers.";

// A context-window overflow can't be retried as-is. OpenClaw's own error text
// advises its `/reset` / `/new` slash commands, but Pinchy's web composer sends
// those as literal messages (they'd just trigger another error). Point the user
// at the controls Pinchy actually has — the Compact action or a fresh chat (#611).
export const CONTEXT_OVERFLOW_HINT =
  "Compact this conversation from the chat header, or start a new chat.";

// User-facing replacement for OpenClaw's raw context-overflow text, which embeds
// the misleading `/reset` advice. Only the banner uses this; the audit trail
// keeps the raw provider text.
export const CONTEXT_OVERFLOW_MESSAGE =
  "This conversation is too long for the model's context window.";

export function getErrorHint(errorText: string, userRole: string): string | null {
  // Context-overflow first: it's specific, role-independent, and must not fall
  // through to the generic/provider branches (or to null, the pre-#611 behavior).
  if (CONTEXT_OVERFLOW_PATTERN.test(errorText)) {
    return CONTEXT_OVERFLOW_HINT;
  }

  // Check transient errors next — "Rate limit exceeded" contains "exceeded"
  // which would otherwise match the provider config pattern.
  if (TRANSIENT_PATTERN.test(errorText)) {
    return "Try again in a moment.";
  }

  if (PROVIDER_CONFIG_PATTERN.test(errorText)) {
    return userRole === "admin" ? PROVIDER_SETTINGS_HINT : "Please contact your administrator.";
  }

  // OpenClaw's generic provider-rejection catch-all (#584). The real cause —
  // most often a provider-account issue like depleted credit or an invalid
  // key — never reaches Pinchy in the chunk text, so the audit class is its
  // own honest `provider_rejected_generic` (not `provider_config`, which
  // would assert an unproven cause). The bare wording reads like a
  // malformed-request bug; pointing an admin at their provider configuration
  // is the most actionable honest guidance we can give without asserting a
  // cause we can't prove.
  if (PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText)) {
    return userRole === "admin" ? PROVIDER_SETTINGS_HINT : "Please contact your administrator.";
  }

  return null;
}

/**
 * Map a raw provider-error string to the user-facing banner text. Rewrites
 * context-overflow errors (OpenClaw's text embeds `/reset`/`/new` advice that
 * doesn't work in Pinchy's composer, #611) and the generic provider-rejection
 * envelope (whose "schema or tool payload" wording reads like a
 * malformed-request bug — #584); passes everything else through untouched.
 * Apply it where the error is shown to the user (the live error frame and the
 * durable-banner route); the audit trail keeps the raw text.
 */
export function presentProviderError(errorText: string): string {
  if (CONTEXT_OVERFLOW_PATTERN.test(errorText)) {
    return CONTEXT_OVERFLOW_MESSAGE;
  }
  // The generic envelope is rewritten to an honest account-issue message — but
  // ONLY when it isn't carrying a thought_signature, which is a schema
  // rejection (#338) with its own user-facing handling. Without this guard the
  // schema-rejection wording would be collapsed into the account-issue message.
  if (
    PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText) &&
    !isThoughtSignatureRejection(errorText)
  ) {
    return PROVIDER_REJECTED_GENERIC_MESSAGE;
  }
  return errorText;
}
