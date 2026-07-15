import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession, auth, type Session } from "@/lib/auth";
import { extractScopes, type ApiKeyScope } from "@/lib/api-key-scopes";
import { appendAuditLog } from "@/lib/audit";

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
 * handlers so a route can attribute actions (audit trail) without
 * re-verifying the key.
 *
 * Deliberately carries no user: a key belongs to the organization, not to the
 * admin who created it (lib/api-key-identity.ts). Its `referenceId` is a
 * constant service-account id, so there is nothing here to resolve to a
 * person — and a route must not attribute a key's action to one. The key IS
 * the actor (design D2). Whoever created it is provenance, recorded on the
 * key itself and surfaced in settings, not re-asserted on every request.
 */
export type ApiKeyContext = {
  keyId: string;
  name: string;
  scopes: ApiKeyScope[];
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
 *   - key fails verification / no key   → 401 Unauthorized (covers a revoked,
 *     expired or disabled key: the plugin reports those as `valid: false`)
 *   - `verifyApiKey` unexpectedly throws → 401 Unauthorized (never open)
 *   - missing a required scope          → 403 Forbidden, audited
 *
 * On success the handler is called with an `ApiKeyContext` describing the
 * caller. Scope authorization only; routes still audit their own actions.
 *
 * Example:
 *   export const POST = withApiKey(["agents:write"], async (req, _ctx, key) => {
 *     return NextResponse.json({ actor: key.keyId });
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
    // Deliberately NOT audited — see the scope denial below for why.
    if (!res?.valid || !res.key) return unauthorized();

    const scopes = extractScopes(res.key.permissions);
    if (!required.every((s) => scopes.includes(s))) {
      // A verified key reaching past its grants is worth a row: it's either a
      // misconfigured client or a stolen key being probed, and telling those
      // apart later needs the attempt on record. Bounded, too — the caller
      // holds a real key, so this can't be spammed by just anyone.
      //
      // The 401s above get no such row, deliberately. Anyone on the internet
      // can present a garbage key, the plugin's rate limiter is off (see
      // lib/auth.ts) and Pinchy has no replacement — so auditing them would
      // hand an unauthenticated attacker an unbounded write into the audit
      // table, burying exactly the denials below. And a key that fails
      // verification has no id to attribute anyway. Worth revisiting if a
      // limiter ever lands.
      //
      // Awaited, not fire-and-forget: `after()` isn't available on every
      // runtime path this wrapper serves, and a denial is cheap. try/catch
      // (the same shape lib/auth.ts uses for auth.failed) keeps a broken
      // audit DB from turning a clean 403 into an unhandled 500 — logging
      // must never gate authorization, in either direction.
      try {
        await appendAuditLog({
          actorType: "api_key",
          actorId: res.key.id,
          eventType: "auth.scope_denied",
          outcome: "failure",
          detail: {
            // Snapshot the name: the key may be revoked by the time anyone
            // reads this, and its row hard-deleted with it.
            apiKey: { id: res.key.id, name: res.key.name ?? "" },
            required: [...required],
            held: scopes,
            path: new URL(req.url).pathname,
          },
        });
      } catch {
        // Don't break authorization if audit logging fails.
      }
      return forbidden();
    }

    return handler(req, ctx, {
      keyId: res.key.id,
      name: res.key.name ?? "",
      scopes,
    });
  };
}
