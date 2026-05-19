import type { ModelUnavailableError, UpstreamFormatError } from "@/lib/schemas/chat-frames";

export type { ModelUnavailableError, UpstreamFormatError };

const HTTP_5XX_PATTERN = /HTTP\s+(5\d\d)\b/i;
const REF_PATTERN = /ref:\s*([\w-]+)/i;
// Matches `thought_signature` (snake_case, native Google path) and
// `thoughtSignature` (camelCase, OpenAI-compat replay paths).
// Issue #338 / upstream openclaw/openclaw#72879 (and #34008 for Ollama Cloud).
const THOUGHT_SIGNATURE_PATTERN = /thought[_]?signature/i;

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
  if (!THOUGHT_SIGNATURE_PATTERN.test(errorText)) return null;
  const refMatch = REF_PATTERN.exec(errorText);
  return {
    kind: "upstream_format_error",
    model,
    errorPattern: "thought_signature",
    ref: refMatch?.[1],
  };
}
