import {
  TRANSIENT_PATTERN,
  PROVIDER_CONFIG_PATTERN,
  PROVIDER_REJECTED_GENERIC_PATTERN,
  CONTEXT_OVERFLOW_PATTERN,
} from "@/server/error-patterns";

export const PROVIDER_SETTINGS_HINT = "Go to Settings > Providers to check your API configuration.";

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
  // key — never reaches Pinchy in the chunk text, so the audit class stays
  // honest (`unknown`). The bare wording reads like a malformed-request bug;
  // pointing an admin at their provider configuration is the most actionable
  // honest guidance we can give without asserting a cause we can't prove.
  if (PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText)) {
    return userRole === "admin" ? PROVIDER_SETTINGS_HINT : "Please contact your administrator.";
  }

  return null;
}

/**
 * Map a raw provider-error string to the user-facing banner text. Currently this
 * only rewrites context-overflow errors — OpenClaw's text embeds `/reset`/`/new`
 * advice that doesn't work in Pinchy's composer (#611) — and passes everything
 * else through untouched. Apply it where the error is shown to the user (the live
 * error frame and the durable-banner route); the audit trail keeps the raw text.
 */
export function presentProviderError(errorText: string): string {
  if (CONTEXT_OVERFLOW_PATTERN.test(errorText)) {
    return CONTEXT_OVERFLOW_MESSAGE;
  }
  return errorText;
}
