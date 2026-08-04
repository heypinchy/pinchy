export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    /**
     * The whole parsed error payload. The escape hatch for the routes that
     * carry a field beyond `{ error, message, details }` — e.g.
     * `/api/setup/provider` answers a `docs` link with its 400. Without it,
     * such a caller would have to drop back to a raw `fetch` and hand-roll the
     * error contract again, which is the drift this module exists to stop.
     */
    public readonly body?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FALLBACK_MESSAGE = "Something went wrong. Please try again.";

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The error contract routes actually use is `{ error, message?, details? }`,
 * where `error` is a short headline and `message` — when present — is the
 * sentence that tells the user what to do about it ("Your license includes 5
 * seats… Remove an existing user or email sales@…"). Reading only `error`
 * dropped that half on the floor, so the toast said "Seat limit reached" and
 * nothing else. Join them; skip the join when a route sends the same text
 * twice, so the toast never stutters.
 */
export function buildErrorMessage(error?: string, message?: string): string {
  if (error && message && error !== message) return `${error} — ${message}`;
  return error ?? message ?? FALLBACK_MESSAGE;
}

/**
 * The server's own wording when it sent any, otherwise the caller's
 * context-specific fallback.
 *
 * Prefer this over a bare `e.message` in a catch block. `ApiError.message`
 * falls back to a deliberately generic sentence when the route sent no `error`
 * or `message` at all (a bare 500, a proxy's HTML error page), and a component
 * almost always knows something more useful than "Something went wrong" —
 * "Failed to save timezone" at least says which action died. A non-ApiError
 * (a network failure, an aborted request) gets the fallback for the same
 * reason: its `message` is an internal string, not user-facing copy.
 */
export function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.message !== FALLBACK_MESSAGE) return e.message;
  return fallback;
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
    const errBody = (parsedBody ?? {}) as {
      error?: unknown;
      message?: unknown;
      details?: unknown;
    };
    // `asString` is not defensiveness for its own sake: a handful of routes
    // put an OBJECT under `error` (`{ error: { message } }`), and passing that
    // to `new Error(...)` shows the user "[object Object]". Fall back instead.
    // The fallback is surfaced to end users via toast, so keep it a human
    // sentence; the numeric status stays on ApiError.status for logging.
    const error = asString(errBody.error);
    const serverMessage = asString(errBody.message);
    throw new ApiError(
      res.status,
      buildErrorMessage(error, serverMessage),
      errBody.details,
      parsedBody
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
