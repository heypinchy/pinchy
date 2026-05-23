/**
 * Umbrella classifier for OpenClaw error chunks that reach the chat WS error
 * surface. Used for `chat.agent_error` audit-log measurement (issue #355) —
 * categorises every error chunk into a small set of stable labels so the
 * audit table can be aggregated by class without ad-hoc string matching at
 * query time.
 *
 * Separate from the specialised classifiers in `model-error-classifier.ts`:
 * those decide whether to fire a richly-typed audit event (model_unavailable,
 * upstream_format_error) and require model context. This one runs on every
 * error chunk regardless, including the silent-stream timeout path where
 * Pinchy synthesises the error itself.
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
  HTTP_5XX_PATTERN,
} from "@/server/error-patterns";

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
  | "transient"
  | "provider_config"
  | "silent_stream_timeout"
  | "unknown";

const FAILOVER_INCOMPLETE_STREAM_PATTERN = /FailoverError[\s\S]*incomplete terminal response/i;

// Mirrors the narrower regex anchoring in model-error-classifier.ts: both
// real OpenClaw variants carry a separator (snake_case `_` or camelCase `S`),
// so a future provider error mentioning a bare-word `thoughtsignature` in
// unrelated text cannot hijack this branch.
const THOUGHT_SIGNATURE_SNAKE = /thought_signature/i;
const THOUGHT_SIGNATURE_CAMEL = /thoughtSignature/;

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

export function classifyAgentError(errorText: string): AgentErrorClass {
  if (FAILOVER_INCOMPLETE_STREAM_PATTERN.test(errorText)) {
    return "failover_incomplete_stream";
  }
  if (THOUGHT_SIGNATURE_SNAKE.test(errorText) || THOUGHT_SIGNATURE_CAMEL.test(errorText)) {
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
  return "unknown";
}
