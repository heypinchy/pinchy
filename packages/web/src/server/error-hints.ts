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
// never reaches Pinchy in the chunk text. This honest, hedged message points an
// admin at the provider-account cause family without asserting a specific cause.
// getErrorHint already treats this same string as a provider-config pointer, so
// the banner agrees instead of showing the raw contradiction. Only the banner
// uses this; the audit trail keeps the raw text.
export const PROVIDER_REJECTED_GENERIC_MESSAGE =
  "The AI provider rejected the request. This is often a provider-account issue (billing, API key, or quota) — check Settings > AI Provider.";

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
 * Map a raw provider-error string to the user-facing banner text. `modelName`
 * is the model Pinchy dispatched to (`agent.model`/the durable row's stored
 * model) — data Pinchy already has independent of the error text, since it's
 * the one that made the request. Apply this where the error is shown to the
 * user (the live error frame and the durable-banner route); the audit trail
 * and the stored row always keep the raw, unmodified text.
 */
export function presentProviderError(errorText: string, modelName?: string): string {
  if (matchesRetirement(errorText)) {
    return MODEL_RETIRED_MESSAGE(modelName);
  }
  if (CONTEXT_OVERFLOW_PATTERN.test(errorText)) {
    return CONTEXT_OVERFLOW_MESSAGE;
  }
  // OpenClaw's generic provider-rejection envelope (#584): the "schema or tool
  // payload" wording is actively misleading (it reads like a malformed-request
  // bug when the real cause is an account-side rejection), so — unlike the
  // neutral bare "LLM request failed." fallback below — it's fully replaced with
  // an honest account-issue message rather than passed through with a model
  // name. Guarded by `!isThoughtSignatureRejection`: the Gemini-3 schema
  // rejection (#338) carries the same envelope text plus a thought_signature and
  // has its own user-facing handling (`classifyUpstreamFormatError`); without
  // this guard its wording would be collapsed into the account-issue message.
  if (
    PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText) &&
    !isThoughtSignatureRejection(errorText)
  ) {
    return PROVIDER_REJECTED_GENERIC_MESSAGE;
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
