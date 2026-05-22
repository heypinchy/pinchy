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
 * The `silent_stream_timeout` label is not pattern-matched — it is passed
 * explicitly at the call site that knows it synthesised the error. See
 * `client-router.ts` silent-stream branch.
 */

// TRANSIENT_PATTERN and PROVIDER_CONFIG_PATTERN are shared with error-hints.ts
// via error-patterns.ts — see that file for the canonical regexes and the
// reasoning behind their boundaries. Order is significant at the call site:
// `transient` is checked before `provider_config` because "rate limit
// exceeded" contains "exceeded" which would otherwise match provider-config.
import { TRANSIENT_PATTERN, PROVIDER_CONFIG_PATTERN } from "@/server/error-patterns";

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

const HTTP_5XX_PATTERN = /HTTP\s+5\d\d\b/i;

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
