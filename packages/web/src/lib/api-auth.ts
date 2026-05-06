import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession, type Session } from "@/lib/auth";

/**
 * Standardized API auth error responses. Use these instead of inline
 * `NextResponse.json(...)` so every protected route returns the same shape.
 */
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

/**
 * Check auth + admin role for API routes.
 * Returns the session if the user is an admin, or a NextResponse error otherwise.
 *
 * Prefer `withAdmin()` for new code — it removes the `instanceof NextResponse`
 * branch from every handler. Reach for `requireAdmin()` (or an inline check)
 * only when the wrapper shape doesn't fit, for example:
 *   - the handler must act on the session before the admin check (rare)
 *   - the handler needs to render auth failure as a redirect (browser-flow
 *     endpoints like OAuth callbacks) rather than a JSON response — wrappers
 *     always return JSON.
 */
export async function requireAdmin(): Promise<Session | NextResponse> {
  const session = await getSession({
    headers: await headers(),
  });
  if (!session?.user) {
    return unauthorized();
  }
  if (session.user.role !== "admin") {
    return forbidden();
  }
  return session;
}

type AuthedHandler<C> = (
  req: NextRequest,
  ctx: C,
  session: Session
) => Promise<NextResponse> | NextResponse;

/**
 * Wraps an authenticated route handler. Resolves the session, returns a
 * standardized 401 on missing auth, otherwise calls
 * `handler(req, ctx, session)`.
 *
 * Example:
 *   export const GET = withAuth(async (req, _ctx, session) => {
 *     return NextResponse.json({ id: session.user.id });
 *   });
 */
export function withAuth<C = unknown>(handler: AuthedHandler<C>) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    const session = await getSession({ headers: await headers() });
    if (!session?.user) {
      return unauthorized();
    }
    return handler(req, ctx, session);
  };
}

/**
 * Same as `withAuth` plus a role check; returns a standardized 403 on
 * non-admin.
 */
export function withAdmin<C = unknown>(handler: AuthedHandler<C>) {
  return withAuth<C>((req, ctx, session) => {
    if (session.user.role !== "admin") {
      return forbidden();
    }
    return handler(req, ctx, session);
  });
}
