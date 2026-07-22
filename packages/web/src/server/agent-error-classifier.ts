/**
 * Umbrella classifier for OpenClaw error chunks that reach the chat WS error
 * surface. Used for `chat.agent_error` audit-log measurement (issue #355) —
 * categorises every error chunk into a small set of stable labels so the
 * audit table can be aggregated by class without ad-hoc string matching at
 * query time.
 *
 * Separate from the specialised classifiers in `model-error-classifier.ts`:
 * those decide whether to fire a richly-typed audit event (model_unavailable)
 * and require model context. This one runs on every error chunk regardless,
 * including the silent-stream timeout path where Pinchy synthesises the
 * error itself.
 *
 * The `silent_stream_timeout` label is not pattern-matched — it is mapped
 * from a `SynthesisedErrorReason` via `classifySynthesisedError()`. Call
 * sites that synthesise their own error frame must use that helper rather
 * than passing a string literal, so adding a future synthesised-error site
 * is a compile error here (forces a new `SynthesisedErrorReason` arm and a
 * matching `AgentErrorClass` label) instead of a silent audit-coverage gap.
 */

// Shared regexes live in error-patterns.ts — see that file for the canonical
// definitions and the reasoning behind their boundaries. Order is significant
// at the call site: `transient` is checked before `provider_config` because
// "rate limit exceeded" contains "exceeded" which would otherwise match
// provider-config. `HTTP_5XX_PATTERN` is also imported from there so a future
// regex tweak doesn't require editing two files.
import {
  TRANSIENT_PATTERN,
  PROVIDER_CONFIG_PATTERN,
  PROVIDER_REJECTED_GENERIC_PATTERN,
  isThoughtSignatureRejection,
  HTTP_5XX_PATTERN,
  matchesRetirement,
} from "@/server/error-patterns";
import type { TransientReason } from "@/lib/schemas/chat-frames";

/**
 * Stable, write-once label set persisted into `audit_log.detail.errorClass`
 * by the `chat.agent_error` event. Once a label has landed in production
 * rows it must NEVER be renamed — operators run dashboards and SQL queries
 * grouped by `detail->>'errorClass'`, and the audit table is append-only +
 * HMAC-signed so historical rows cannot be migrated to a new spelling
 * without breaking the HMAC chain. Add new labels here; never rename
 * existing ones. Removing a label is also a breaking change for any
 * persisted dashboard.
 */
export type AgentErrorClass =
  | "failover_incomplete_stream"
  | "schema_rejection"
  | "model_unavailable"
  | "model_retired"
  | "transient"
  | "provider_config"
  | "provider_rejected_generic"
  | "silent_stream_timeout"
  | "unknown";

const FAILOVER_INCOMPLETE_STREAM_PATTERN = /FailoverError[\s\S]*incomplete terminal response/i;

/**
 * Reasons Pinchy itself synthesises an error frame (no upstream provider
 * text exists to pattern-match). Today: only the silent-stream watchdog at
 * the bottom of `pipeStream` in `client-router.ts`. Add a new arm here if
 * another synthesised-error site appears — the exhaustive switch in
 * `classifySynthesisedError` will refuse to compile until the new reason
 * has a corresponding `AgentErrorClass` label, which is the point.
 */
export type SynthesisedErrorReason = "silent_stream";

/**
 * Map a synthesised-error reason to its stable audit class label. Exhaustive
 * over `SynthesisedErrorReason`: the `_never` fallthrough is a compile-time
 * assertion that every reason has an explicit case, so adding a new reason
 * to the union forces the maintainer to decide on its audit label rather
 * than defaulting to `unknown` and silently muddying the umbrella query.
 */
export function classifySynthesisedError(reason: SynthesisedErrorReason): AgentErrorClass {
  switch (reason) {
    case "silent_stream":
      return "silent_stream_timeout";
    default: {
      const _never: never = reason;
      return _never;
    }
  }
}

/**
 * Whether an agent error of this class should persist a durable "paused" banner
 * (chat_session_errors), versus showing inline only.
 *
 * The banner re-surfaces an error a user might have MISSED after a
 * reload/reconnect (see chat-error-banner.tsx / chat-states.mdx). Two families
 * qualify (#882):
 *
 *   1. Retryable/intermittent failures whose ephemeral live bubble died on a
 *      reload — a fresh attempt may well succeed, so re-surface it on return.
 *   2. Permanent AND ACTIONABLE failures — a retired model, a bad provider
 *      config, an account-side provider rejection. These recur every attempt,
 *      but the user (or an admin) CAN fix them, and the fix is exactly what the
 *      banner names (which model died + how to change it; check the provider
 *      config). This is the surface AGENTS.md's error-UI guidance prescribes for
 *      a "permanent, actionable error". The banner is dismissible and is
 *      auto-superseded on the next successful turn (see supersedeChatSessionErrors
 *      in client-router), so it can't linger past the fix — the earlier
 *      "sticky annoyance" concern only holds for a permanent NON-actionable
 *      error, which is exactly the `unknown` bucket kept out below.
 *
 * Only `unknown` (a truly unrecognised string with no nameable cause or action)
 * stays inline-only, to avoid banner noise for the long tail. A retired model
 * whose token survives over the wire classifies as `model_retired` and persists;
 * a fully collapsed "LLM request failed." with no token stays `unknown` and does
 * not (there's nothing actionable to put in the banner).
 *
 * Exhaustive over `AgentErrorClass` (no `default`) so adding a future class is a
 * compile error until its durability is explicitly decided — same discipline as
 * `classifySynthesisedError` below.
 */
export function shouldPersistDurableError(errorClass: AgentErrorClass): boolean {
  switch (errorClass) {
    // Retryable / intermittent — a reload could have lost the live bubble and a
    // fresh attempt may well succeed, so re-surface it on return.
    case "transient":
    case "silent_stream_timeout":
    case "model_unavailable":
    case "schema_rejection":
    case "failover_incomplete_stream":
    // Permanent but ACTIONABLE — the banner names the fix (retired model → change
    // it; provider config / account rejection → check the provider settings) and
    // clears on dismiss or the next success, so it helps rather than nags (#882).
    case "model_retired":
    case "provider_config":
    case "provider_rejected_generic":
      return true;
    // Permanent and NON-actionable — a truly unrecognised failure with no
    // nameable cause. Nothing useful to put in a durable banner, so it shows
    // inline only.
    case "unknown":
      return false;
  }
}

// Sub-partition of TRANSIENT_PATTERN so the chat bubble can be honest about the
// specific cause. `transient` (the audit class) spans rate-limit, overloaded,
// timeout and HTTP 529 — calling all of them "rate limit" in the UI would be a
// lie for an overloaded/timeout failure. Order matters: "rate limit exceeded"
// is rate_limit, not a generic match. Only called once a text has already been
// classified `transient`; unknown-transient text falls back to "unavailable"
// rather than guessing a specific cause.
const RATE_LIMIT_REASON_PATTERN = /rate[_ ]?limit|too many requests/i;
const OVERLOADED_REASON_PATTERN = /overloaded|529/i;
const TIMEOUT_REASON_PATTERN = /time[_ ]?d?[_ ]?out/i;

export function classifyTransientReason(errorText: string): TransientReason {
  if (RATE_LIMIT_REASON_PATTERN.test(errorText)) return "rate_limit";
  if (OVERLOADED_REASON_PATTERN.test(errorText)) return "overloaded";
  if (TIMEOUT_REASON_PATTERN.test(errorText)) return "timeout";
  return "unavailable";
}

export function classifyAgentError(errorText: string): AgentErrorClass {
  if (FAILOVER_INCOMPLETE_STREAM_PATTERN.test(errorText)) {
    return "failover_incomplete_stream";
  }
  // Retirement (HTTP 410 / "retired" / "unknown model") is the most specific
  // AVAILABILITY signal, so it's classified before the transient/5xx/config
  // families below — mirroring the same precedence in `presentProviderError`
  // and `getErrorHint`, which check `matchesRetirement` first. A retired model
  // is permanent AND actionable (an admin must pick a different model), so it
  // earns its own class rather than falling through to `unknown`: that both
  // keeps the audit dashboards honest and lets `shouldPersistDurableError`
  // surface the durable, model-naming banner the retired case needs (#882).
  // Checked AFTER failover_incomplete_stream because that payload carries no
  // retirement token, so the order is safe either way but reads as
  // most-specific-first. See `matchesRetirement` for the token set and the
  // note that a fully collapsed "LLM request failed." carries no token and so
  // correctly stays `unknown`.
  if (matchesRetirement(errorText)) {
    return "model_retired";
  }
  if (isThoughtSignatureRejection(errorText)) {
    return "schema_rejection";
  }
  // `transient` is checked before `model_unavailable` so HTTP 529 — Anthropic's
  // canonical "overloaded, retry" signal — classifies as transient rather than
  // being swept into the broader 5xx bucket. Plain HTTP 500/502/503/504 with
  // bare error text don't match TRANSIENT_PATTERN and fall through correctly.
  if (TRANSIENT_PATTERN.test(errorText)) {
    return "transient";
  }
  if (HTTP_5XX_PATTERN.test(errorText)) {
    return "model_unavailable";
  }
  if (PROVIDER_CONFIG_PATTERN.test(errorText)) {
    return "provider_config";
  }
  // OpenClaw's generic provider-rejection catch-all (#584). When a provider
  // rejects a run for an account-side reason it collapses (verified on staging:
  // depleted credit surfaces as exactly this string), the real cause never
  // reaches Pinchy in the chunk text. Honest own audit class — NOT
  // `provider_config` (that would assert an unproven cause in the append-only
  // audit trail) and NOT `unknown` (that buckets it with truly unrecognised
  // strings). Checked AFTER provider_config and schema_rejection above, so a
  // chunk that carries the envelope PLUS a concrete cause (credit/balance) or a
  // thought_signature still classifies by the specific signal.
  if (PROVIDER_REJECTED_GENERIC_PATTERN.test(errorText)) {
    return "provider_rejected_generic";
  }
  return "unknown";
}
