import type { ModelUnavailableError } from "@/lib/schemas/chat-frames";
import { HTTP_5XX_PATTERN, TRANSIENT_PATTERN } from "@/server/error-patterns";

export type { ModelUnavailableError };

const REF_PATTERN = /ref:\s*([\w-]+)/i;

export function classifyModelError(errorText: string, model: string): ModelUnavailableError | null {
  if (!model) return null;
  // Give transient overloads the same precedence the umbrella classifier
  // (agent-error-classifier) enforces: HTTP 529 (Anthropic "overloaded, retry")
  // matches HTTP_5XX_PATTERN but is transient, not a model-unavailable. Without
  // this short-circuit the two classifiers disagree on the same chunk and the
  // dedicated model_unavailable dashboard gets polluted with 529 overloads.
  if (TRANSIENT_PATTERN.test(errorText)) return null;
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
