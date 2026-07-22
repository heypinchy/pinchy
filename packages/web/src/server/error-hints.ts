import {
  TRANSIENT_PATTERN,
  PROVIDER_CONFIG_PATTERN,
  PROVIDER_REJECTED_GENERIC_PATTERN,
  isThoughtSignatureRejection,
  CONTEXT_OVERFLOW_PATTERN,
  matchesRetirement,
} from "@/server/error-patterns";

export const PROVIDER_SETTINGS_HINT =
  "Go to Settings > AI Provider to check your API configuration.";

// User-facing replacement for OpenClaw's generic provider-rejection envelope
// (#584). The raw wording — "provider rejected the request schema or tool
// payload" — reads like a malformed-request bug; the real cause (most often a
// provider-account issue: billing, API key, quota) is collapsed by OpenClaw and
// never reaches Pinchy in the chunk text. This honest, hedged message names the
// provider-account cause family without asserting a specific cause. Deliberately
// role-NEUTRAL (like MODEL_RETIRED_MESSAGE / CONTEXT_OVERFLOW_MESSAGE):
// presentProviderError takes no role, so baking in the admin-only "check
// Settings > AI Provider" action would tell a member to visit a page they can't
// reach and contradict getErrorHint's member guidance ("contact your
// administrator"). The banner describes; the role-gated action lives in the
// hint. Only the banner uses this; the audit trail keeps the raw text.
export const PROVIDER_REJECTED_GENERIC_MESSAGE =
  "The AI provider rejected the request. This is often a provider-account issue — billing, API key, or quota.";

// A retired model can't be retried as-is — an admin needs to pick a different
// one for this agent. Deliberately NOT an automatic swap: an admin pinned this
// model for a reason (cost, compliance, data residency, capability), and a
// silent background change would undermine that governance decision the same
// way the removed old "recovery dialog" did (see resolveImageTurnModel's
// comment in client-router.ts). If this becomes a one-click suggested-swap
// affordance later, it must go through the existing audited
// `PATCH /api/agents/[agentId]` path, never a new silent one.
export const MODEL_RETIRED_HINT_ADMIN = "Choose a different model for this agent in its settings.";
export const MODEL_RETIRED_HINT_MEMBER = "Please contact your administrator.";

// Pinchy already knows which model it dispatched to (it's the one that made
// the request), so it can name it even though the retirement DATE never
// reaches us (see matchesRetirement's doc comment — that's an upstream
// OpenClaw limitation, not something we can parse around).
export function MODEL_RETIRED_MESSAGE(modelName?: string): string {
  return modelName
    ? `The model "${modelName}" is no longer available — the provider has retired it.`
    : "The agent's model is no longer available — the provider has retired it.";
}

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
  // Retirement first, same reasoning as context-overflow: specific, and must
  // not fall through to the generic/provider branches.
  if (matchesRetirement(errorText)) {
    return userRole === "admin" ? MODEL_RETIRED_HINT_ADMIN : MODEL_RETIRED_HINT_MEMBER;
  }

  // Context-overflow next: it's specific, role-independent, and must not fall
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
  // key — never reaches Pinchy in the chunk text, so it gets its own honest
  // audit class `provider_rejected_generic` (not `provider_config`, which would
  // assert an unproven cause). The bare wording reads like a malformed-request
  // bug; pointing an admin at their provider configuration is the most
  // actionable honest guidance we can give without asserting a cause we can't
  // prove.
  if (PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText)) {
    return userRole === "admin" ? PROVIDER_SETTINGS_HINT : "Please contact your administrator.";
  }

  return null;
}

/**
 * The canned, cause-specific rewrite for a provider error — or `null` when there
 * is no rewrite and the raw text would be shown verbatim (rate-limit,
 * provider-config, the bare `"LLM request failed."`, …).
 *
 * The `null` return is a security signal for callers handling UNTRUSTED text: a
 * THROWN generator rejection's `message` is not guaranteed to be provider-facing
 * (it can be an internal Node/infra error carrying a host/IP, a DB auth failure,
 * or a stack trace). Such a caller must NOT echo the raw text, so it treats a
 * `null` here as "surface the generic bubble instead" — see `surfaceRunFailure`
 * in client-router (#882). Callers with provider-facing text by construction (an
 * in-stream `error` chunk) use `presentProviderError` below, which falls back to
 * the raw text when there's no canned rewrite.
 */
export function cannedProviderMessage(errorText: string, modelName?: string): string | null {
  if (matchesRetirement(errorText)) {
    return MODEL_RETIRED_MESSAGE(modelName);
  }
  if (CONTEXT_OVERFLOW_PATTERN.test(errorText)) {
    return CONTEXT_OVERFLOW_MESSAGE;
  }
  // OpenClaw's generic provider-rejection envelope (#584): the "schema or tool
  // payload" wording is actively misleading (it reads like a malformed-request
  // bug when the real cause is an account-side rejection), so — unlike the
  // neutral bare "LLM request failed." fallback in presentProviderError — it's
  // fully replaced with an honest account-issue message rather than passed
  // through with a model name. Guarded by `!isThoughtSignatureRejection`: the
  // same envelope text plus a thought_signature marker identifies the distinct
  // Gemini-3 replay defect (#338, fixed in OpenClaw 2026.7.1 — the dedicated
  // user-facing "Retry usually works" bubble was removed once the fix was
  // verified, but the marker itself stays here so a thought_signature rejection
  // is never mislabeled as the #584 account-issue message).
  if (
    PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText) &&
    !isThoughtSignatureRejection(errorText)
  ) {
    return PROVIDER_REJECTED_GENERIC_MESSAGE;
  }
  return null;
}

/**
 * Map a raw provider-error string to the user-facing banner text. `modelName`
 * is the model Pinchy dispatched to (`agent.model`/the durable row's stored
 * model) — data Pinchy already has independent of the error text, since it's
 * the one that made the request. Apply this where the error is shown to the
 * user AND the text is provider-facing by construction (the live error frame
 * for an in-stream `error` chunk, and the durable-banner route reading a stored
 * row); the audit trail and the stored row always keep the raw, unmodified
 * text. For UNTRUSTED thrown text use `cannedProviderMessage` and fall back to a
 * generic message on `null` instead of echoing the raw input.
 */
export function presentProviderError(errorText: string, modelName?: string): string {
  const canned = cannedProviderMessage(errorText, modelName);
  if (canned !== null) {
    return canned;
  }
  // Final fallback: everything else (rate-limit, provider-config, and any truly
  // unclassified text like the bare `"LLM request failed."`) is shown as-is
  // EXCEPT we still append which model was involved, when known. The real
  // staging incident's stored providerError was that bare fallback with NO
  // retirement token to match above, so `matchesRetirement` never fires for it —
  // but Pinchy still knows which model it dispatched to regardless of WHY the
  // dispatch failed, and naming it turns a fully opaque message into something
  // actionable without asserting an unproven cause.
  return modelName ? `${errorText} (model: ${modelName})` : errorText;
}
