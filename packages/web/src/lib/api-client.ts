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
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      (errBody as { error?: string }).error ?? `Request failed: ${res.status}`,
      (errBody as { details?: unknown }).details
    );
  }
  if (res.status === 204) return undefined as R;
  return res.json() as Promise<R>;
}

export const apiPost = <R = unknown, B = unknown>(url: string, body: B): Promise<R> =>
  send<R>(url, "POST", body);
export const apiPatch = <R = unknown, B = unknown>(url: string, body: B): Promise<R> =>
  send<R>(url, "PATCH", body);
export const apiPut = <R = unknown, B = unknown>(url: string, body: B): Promise<R> =>
  send<R>(url, "PUT", body);
export const apiDelete = <R = void>(url: string): Promise<R> => send<R>(url, "DELETE");
export const apiGet = <R = unknown>(url: string): Promise<R> => send<R>(url, "GET");
