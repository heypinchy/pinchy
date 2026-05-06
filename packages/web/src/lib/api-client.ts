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
export const apiDelete = <R = void>(url: string): Promise<R> => send<R>(url, "DELETE");
export const apiGet = <R = unknown>(url: string): Promise<R> => send<R>(url, "GET");
