import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession, auth, type Session } from "@/lib/auth";
import { extractScopes, type ApiKeyScope } from "@/lib/api-key-scopes";

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

/**
 * Resolved identity of an authenticated API key. Passed to `withApiKey`
 * handlers so a route can attribute actions (audit trail) and enforce
 * ownership without re-verifying the key.
 *
 * `issuerUserId` is the key's owner — better-auth exposes it as
 * `referenceId` (there is no `userId` on the verify output).
 */
export type ApiKeyContext = {
  keyId: string;
  name: string;
  scopes: ApiKeyScope[];
  issuerUserId: string;
};

type ApiKeyHandler<C> = (
  req: NextRequest,
  ctx: C,
  key: ApiKeyContext
) => Promise<NextResponse> | NextResponse;

/**
 * Reads the API key from the request. Prefers `Authorization: Bearer <key>`,
 * falling back to the `x-api-key` header (better-auth's default). Returns
 * `null` when neither carries a key.
 */
function readApiKey(req: NextRequest): string | null {
  const h = req.headers.get("Authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return req.headers.get("x-api-key");
}

/**
 * Wraps a route handler behind API-key authentication + scope authorization.
 * Programmatic clients (Agent Provisioning API, #572) present a `pinchy_`
 * key instead of a session cookie.
 *
 * Fail-closed on every path — the handler runs only for a verified key that
 * holds *all* `required` scopes:
 *   - no key header                     → 401 Unauthorized
 *   - key fails verification / no key   → 401 Unauthorized
 *   - `verifyApiKey` unexpectedly throws → 401 Unauthorized (never open)
 *   - missing a required scope          → 403 Forbidden
 *
 * On success the handler is called with an `ApiKeyContext` describing the
 * caller. Scope authorization only; routes still do their own auditing.
 *
 * Example:
 *   export const POST = withApiKey(["agents:write"], async (req, _ctx, key) => {
 *     return NextResponse.json({ createdBy: key.issuerUserId });
 *   });
 */
export function withApiKey<C = unknown>(
  required: [ApiKeyScope, ...ApiKeyScope[]],
  handler: ApiKeyHandler<C>
) {
  return async (req: NextRequest, ctx: C): Promise<NextResponse> => {
    const key = readApiKey(req);
    if (!key) return unauthorized();

    // Fail closed: `verifyApiKey` catches internally today, but a malformed
    // input or a future plugin version must never fall through as
    // authenticated. `.catch(() => null)` collapses any throw to a denial.
    const res = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
    if (!res?.valid || !res.key) return unauthorized();

    const scopes = extractScopes(res.key.permissions);
    if (!required.every((s) => scopes.includes(s))) return forbidden();

    return handler(req, ctx, {
      keyId: res.key.id,
      name: res.key.name ?? "",
      scopes,
      issuerUserId: res.key.referenceId,
    });
  };
}
