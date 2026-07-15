import { NextRequest } from "next/server";

/**
 * Build a `NextRequest` for route-handler tests.
 *
 * App Router handlers are typed `(req: NextRequest, ctx) => Response`. Tests
 * that pass a plain `new Request(...)` fail type-checking (`Request` is not
 * assignable to `NextRequest`). Construct requests here so the correct type is
 * used everywhere.
 */
export function makeNextRequest(
  url = "http://localhost/api/test",
  // NextRequest's constructor takes Next's own RequestInit (not the global
  // lib.dom one), so derive the exact param type from the constructor.
  init?: ConstructorParameters<typeof NextRequest>[1]
): NextRequest {
  return new NextRequest(url, init);
}

/**
 * Build the second argument every App Router handler receives — the route
 * context `{ params: Promise<...> }`.
 *
 * Pinchy's `withAuth`/`withAdmin` wrappers return `(req, ctx) => ...`, so the
 * context arg is REQUIRED even for routes that ignore it. Static (non-dynamic)
 * routes: `routeContext()`. Dynamic routes: `routeContext({ id: "agent-1" })`,
 * which yields `{ params: Promise<{ id: string }> }` matching the handler's
 * declared context type. Next 15+ makes `params` a Promise, so awaiting it in
 * the handler works exactly as in production.
 */
export function routeContext(): { params: Promise<Record<string, never>> };
export function routeContext<T extends Record<string, string>>(params: T): { params: Promise<T> };
export function routeContext(params?: Record<string, string>) {
  return { params: Promise.resolve(params ?? {}) };
}
