export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function send<R>(url: string, method: string, body?: unknown): Promise<R> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Read the body as text so we can handle empty responses (204, or 2xx with no
  // body) without forcing a JSON parse on an empty buffer.
  const rawBody = await res.text().catch(() => "");
  const parsedBody = rawBody.length > 0 ? safeParseJson(rawBody) : undefined;

  if (!res.ok) {
    const errBody = (parsedBody ?? {}) as { error?: string; details?: unknown };
    // The fallback message is surfaced to end users via toast. Keep it
    // human-readable; the numeric status is still available on ApiError.status
    // for logging and conditional handling.
    throw new ApiError(
      res.status,
      errBody.error ?? "Something went wrong. Please try again.",
      errBody.details
    );
  }
  return (parsedBody as R) ?? (undefined as R);
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const apiPost = <R = unknown, B = unknown>(url: string, body: B): Promise<R> =>
  send<R>(url, "POST", body);
export const apiPatch = <R = unknown, B = unknown>(url: string, body: B): Promise<R> =>
  send<R>(url, "PATCH", body);
export const apiPut = <R = unknown, B = unknown>(url: string, body: B): Promise<R> =>
  send<R>(url, "PUT", body);
// `body` is optional: most DELETE routes key off the URL, but a few take a JSON
// body (e.g. the OpenAI-compatible provider delete, which validates `{ id }`).
export const apiDelete = <R = void, B = unknown>(url: string, body?: B): Promise<R> =>
  send<R>(url, "DELETE", body);
export const apiGet = <R = unknown>(url: string): Promise<R> => send<R>(url, "GET");

/**
 * Unwrap a `parseRequestBody` validation failure into a flat
 * `{ fieldName: firstMessage }` map for inline form errors.
 *
 * Returns null when the error is not a structured field-level validation
 * failure — the caller should fall back to a toast in that case, which is the
 * split AGENTS.md "Error And Notification UI" describes: a field the user can
 * correct gets an inline message, anything else gets a toast.
 *
 * Lives beside ApiError because it reads `ApiError.details`, whose shape is
 * this module's contract with the route layer. It was copied verbatim into two
 * settings components before (#1087).
 */
export function extractFieldErrors(e: unknown): Record<string, string> | null {
  if (!(e instanceof ApiError) || !e.details) return null;
  const details = e.details as { fieldErrors?: Record<string, string[]> };
  const fe = details.fieldErrors;
  if (!fe || typeof fe !== "object") return null;
  const flat: Record<string, string> = {};
  for (const [field, messages] of Object.entries(fe)) {
    if (Array.isArray(messages) && messages.length > 0) flat[field] = messages[0];
  }
  return Object.keys(flat).length > 0 ? flat : null;
}
