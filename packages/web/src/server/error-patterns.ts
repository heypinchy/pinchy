/**
 * Shared error-text classification patterns used by both the user-facing
 * hint generator (`error-hints.ts`) and the audit umbrella classifier
 * (`agent-error-classifier.ts`).
 *
 * Single source of truth: keeping these in one file prevents the two
 * consumers from drifting — if a future provider's error wording forces
 * a pattern tweak, both the UI hint and the audit class update together.
 *
 * Order-of-evaluation matters at each call site (transient must be checked
 * before provider_config so `"rate limit exceeded"` doesn't classify as
 * a config issue). Both consumers implement the same precedence — see
 * their respective files for the reasoning.
 */

/**
 * Matches retryable, time-limited failures. Users should "try again in a
 * moment"; admins shouldn't reach for the provider config.
 *
 * `529` covers Anthropic's canonical "overloaded, retry" status code.
 */
export const TRANSIENT_PATTERN =
  /rate[_ ]?limit|too many requests|time[_ ]?d?[_ ]?out|overloaded|529/i;

/**
 * Matches errors caused by missing/invalid provider configuration:
 * absent or invalid API key, depleted credit, exhausted quota.
 *
 * Deliberately does NOT include the bare word `exceeded` — that would
 * misclassify `"context window exceeded"` (a model-capability issue) as
 * a configuration issue and tell admins to "check your API configuration"
 * which is the wrong fix. `"quota exceeded"` still matches via `quota`,
 * and `"rate limit exceeded"` is caught earlier by TRANSIENT_PATTERN.
 */
export const PROVIDER_CONFIG_PATTERN =
  /credit|balance|api[_ ]?key|invalid.*key|authenticat|unauthorized|quota/i;

/**
 * Matches an "HTTP <5xx>" prefix as emitted by the OpenClaw error envelope
 * for upstream model failures. Capture group exposes the status code for
 * consumers (model-error-classifier) that need to record it; consumers
 * that only need a yes/no signal (agent-error-classifier) ignore it.
 *
 * Requires the literal "HTTP " prefix on purpose — matching bare 3-digit
 * numbers would false-positive on file sizes, port numbers, sums in error
 * envelopes. If real production traffic produces unprefixed "5xx Internal
 * Server Error" payloads they'll show up in the `unknown` audit class
 * before we widen this anchor.
 */
export const HTTP_5XX_PATTERN = /HTTP\s+(5\d\d)\b/i;

/**
 * OpenClaw's generic failover catch-all. When a provider rejects a run for a
 * reason OpenClaw collapses (verified on staging: depleted credit surfaces as
 * this string, not "credit balance too low"), the error chunk carries exactly
 * this wording and nothing else — the distinguishing cause stays in OpenClaw's
 * internal failover decision and never reaches Pinchy (issue #584). Because the
 * real cause is unknowable from this text, it must NOT widen
 * `PROVIDER_CONFIG_PATTERN` (that would assert an unproven cause in the
 * append-only audit trail). It is used only by the user-facing hint to stop
 * showing the bare wording — which reads like a malformed-request bug — and
 * instead point an admin at their provider configuration.
 */
export const PROVIDER_REJECTED_GENERIC_PATTERN =
  /provider rejected the request schema or tool payload/i;

/**
 * Matches OpenClaw's upstream schema/format rejection (verified on staging:
 * Gemini 3 missing `thought_signature` on tool-call replay). Both the snake_case
 * (`thought_signature`) and camelCase (`thoughtSignature`) variants reach Pinchy
 * — the OpenAI-compat replay path used by ollama-cloud emits camelCase, the
 * native Google path emits snake_case. Shared here so the audit classifier
 * (`agent-error-classifier.ts`) and the user-facing rewriter (`error-hints.ts`)
 * agree on what counts as a schema rejection: the generic provider-rejection
 * envelope is rewritten to a clearer account-issue message ONLY when it is NOT
 * carrying a thought_signature (otherwise the schema-rejection wording would be
 * collapsed into the generic-account message — issue #584).
 *
 * Two patterns, mirroring the original narrower anchoring in
 * `model-error-classifier.ts`: the snake_case form carries a `_` separator and
 * is matched case-insensitively; the camelCase form requires the capital `S`
 * (NO `i` flag) so a bare-word `thoughtsignature` in unrelated text cannot
 * hijack the schema_rejection branch.
 */
export const THOUGHT_SIGNATURE_SNAKE_PATTERN = /thought_signature/i;
export const THOUGHT_SIGNATURE_CAMEL_PATTERN = /thoughtSignature/;

/** True if the text carries either thought_signature variant (a schema rejection). */
export function isThoughtSignatureRejection(errorText: string): boolean {
  return (
    THOUGHT_SIGNATURE_SNAKE_PATTERN.test(errorText) ||
    THOUGHT_SIGNATURE_CAMEL_PATTERN.test(errorText)
  );
}

/**
 * Matches a context-window overflow: the conversation/prompt no longer fits the
 * model's context window. A model-capability/length issue, NOT a provider-config
 * one (see PROVIDER_CONFIG_PATTERN's note on deliberately excluding bare
 * `exceeded`). OpenClaw surfaces this with advice to use its `/reset` or `/new`
 * slash commands — which Pinchy's web composer doesn't support — so
 * `error-hints.ts` replaces that advice with a hint pointing at the Compact
 * action instead (#611).
 */
export const CONTEXT_OVERFLOW_PATTERN =
  /context (overflow|window|length)|prompt (is )?too large|larger[- ]context|maximum context|too many (input )?tokens/i;
