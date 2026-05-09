export interface ModelUnavailableError {
  kind: "model_unavailable";
  model: string;
  httpStatus: number;
  ref?: string;
}

const HTTP_5XX_PATTERN = /HTTP\s+(5\d\d)\b/i;
const REF_PATTERN = /ref:\s*([\w-]+)/i;

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
