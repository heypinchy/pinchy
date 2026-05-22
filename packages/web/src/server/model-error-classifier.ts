import type { ModelUnavailableError, UpstreamFormatError } from "@/lib/schemas/chat-frames";
import { HTTP_5XX_PATTERN } from "@/server/error-patterns";

export type { ModelUnavailableError, UpstreamFormatError };

const REF_PATTERN = /ref:\s*([\w-]+)/i;
// Matches `thought_signature` (snake_case, native Google path) and
// `thoughtSignature` (camelCase, OpenAI-compat replay paths). Each variant
// is matched by its own anchor:
//   - snake_case requires the literal underscore (case-insensitive overall
//     so e.g. `THOUGHT_SIGNATURE` from a SHOUTING upstream variant still matches),
//   - camelCase requires the literal upper-case `S` between the two words
//     (case-sensitive on that one character only — keeps the camelCase
//     anchor real, instead of degrading into a bare-word match under `/i`).
// The combined effect: a future provider error mentioning a bare
// `thoughtsignature` (no separator) in unrelated vendor text cannot hijack
// this classifier and trigger the upstream-format-error UX for an unrelated
// bug. Both real OpenClaw variants always carry a separator.
// Issue #338 / upstream openclaw/openclaw#72879 (and #34008 for Ollama Cloud).
// TODO(#338): delete this classifier once openclaw/openclaw#34008 closes and
// our pin includes the fix for the OpenAI-compat replay path. The native
// Google path is already fixed in OpenClaw 2026.5.18; Pinchy production
// routes through Ollama Cloud's OpenAI-compat surface which still drops the
// field.
const THOUGHT_SIGNATURE_SNAKE = /thought_signature/i;
const THOUGHT_SIGNATURE_CAMEL = /thoughtSignature/;
function matchesThoughtSignature(text: string): boolean {
  return THOUGHT_SIGNATURE_SNAKE.test(text) || THOUGHT_SIGNATURE_CAMEL.test(text);
}

export function classifyModelError(errorText: string, model: string): ModelUnavailableError | null {
  if (!model) return null;
  const statusMatch = HTTP_5XX_PATTERN.exec(errorText);
  if (!statusMatch) return null;
  const refMatch = REF_PATTERN.exec(errorText);
  return {
    kind: "model_unavailable",
    model,
    httpStatus: Number(statusMatch[1]),
    ref: refMatch?.[1],
  };
}

export function classifyUpstreamFormatError(
  errorText: string,
  model: string
): UpstreamFormatError | null {
  if (!model) return null;
  if (!matchesThoughtSignature(errorText)) return null;
  const refMatch = REF_PATTERN.exec(errorText);
  return {
    kind: "upstream_format_error",
    model,
    errorPattern: "thought_signature",
    ref: refMatch?.[1],
  };
}
