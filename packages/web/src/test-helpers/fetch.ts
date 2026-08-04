/**
 * Response stubs for tests that spy on `global.fetch`.
 *
 * Every component that mutates goes through `@/lib/api-client`, whose `send()`
 * reads the body with `res.text()` and derives `ok` from the status. A
 * hand-rolled `{ ok: true, json: async () => x } as Response` satisfies neither,
 * and the failure is a rejected promise deep inside the helper rather than an
 * assertion that names the missing method — which is exactly why this lives in
 * one place: the next change to how api-client reads a response is a one-line
 * fix here instead of a sweep across ~250 inline literals (AGENTS.md § "Web
 * Test Files Are Type-Checked").
 *
 * Deliberately a stub rather than a real `new Response(...)`: a real Response
 * body can be read only once, so a mock reused across calls
 * (`mockResolvedValue`, not `…Once`) would throw "Body already read" on the
 * second one. These are re-readable.
 */
export function jsonResponse(body?: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (text.length > 0 ? JSON.parse(text) : undefined),
    headers: new Headers(text.length > 0 ? { "content-type": "application/json" } : {}),
  } as unknown as Response;
}
