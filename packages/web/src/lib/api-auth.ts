import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession, auth, type Session } from "@/lib/auth";
import { extractScopes, type ApiKeyScope } from "@/lib/api-key-scopes";
import { appendAuditLog, safeAuditPath } from "@/lib/audit";
import {
  tryAcquireApiKeySlot,
  claimApiKeyRateLimitAuditSlot,
  API_KEY_RATE_LIMIT_WINDOW_MS,
  tryAcquireInvalidApiKeyIpSlot,
  claimInvalidApiKeyRateLimitAuditSlot,
  INVALID_API_KEY_RATE_LIMIT_WINDOW_MS,
} from "@/lib/api-key-rate-limiter";

/**
 * Standardized API auth error responses. Use these instead of inline
 * `NextResponse.json(...)` so every protected route returns the same shape.
 */
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const tooManyRequests = (retryAfterSeconds: number) =>
  NextResponse.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );

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

const BEARER_PREFIX = "bearer ";

/**
 * Reads the API key from the request. Prefers `Authorization: Bearer <key>`,
 * falling back to the `x-api-key` header (better-auth's default). Returns
 * `null` when neither carries a key.
 *
 * The scheme match is case-insensitive: RFC 7235 §2.1 defines auth-scheme as a
 * case-insensitive token, so `bearer x` is the same request as `Bearer x`.
 * Matching it case-sensitively failed CLOSED — it fell through to x-api-key,
 * found nothing and answered 401 — so this was never a security bug, but a
 * correct request got told its credential was bad.
 */
function readApiKey(req: NextRequest): string | null {
  const h = req.headers.get("Authorization");
  if (h && h.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX) {
    return h.slice(BEARER_PREFIX.length);
  }
  return req.headers.get("x-api-key");
}

/** Bucket key for a caller with no usable `x-forwarded-for` value at all. */
const UNKNOWN_CLIENT_IP = "unknown";

/**
 * Best-effort client IP, used ONLY to bucket the invalid-key-attempt limiter
 * below (`tryAcquireInvalidApiKeyIpSlot`) — never for anything that needs
 * strong identity. `NextRequest` carries no `.ip` (removed after Next
 * 13.4), so this reads `x-forwarded-for`, which Caddy sets on every
 * deployment path (`Caddyfile.dev`, the marketplace `Caddyfile`).
 *
 * Deliberately the LAST hop, not the first: Caddy's `reverse_proxy`
 * *appends* the peer address it directly observed to any inbound value
 * rather than replacing it, so a request can arrive with an
 * attacker-supplied prefix already present. Only the tail is something
 * Caddy itself vouches for. This is a different question from
 * `publicHopOf` in `@/server/forwarded-host`, which reads the FIRST hop of
 * `x-forwarded-host` — that header answers "what did the browser address",
 * this one answers "who do we trust to bucket on", and the trustworthy hop
 * sits at the opposite end for each.
 *
 * A caller with no `x-forwarded-for` at all buckets into one fixed key
 * rather than going unlimited — but be precise about what that buys. It
 * bounds a MISCONFIGURED deployment, not an adversarial one: every path
 * Pinchy ships puts Caddy in front, and where it doesn't, the header is
 * caller-supplied end to end, so an attacker sends one and picks a fresh
 * bucket per request instead of falling into this branch at all. Two things
 * still bind there, by design rather than by luck: the tracked-bucket cap in
 * `tryAcquireInvalidApiKeyIpSlot`, which fails closed rather than growing,
 * and the `auth.rate_limited` audit window, which is global for exactly this
 * reason. Nothing here is a substitute for a limiter in the proxy.
 */
function readClientIp(req: NextRequest): string {
  const header = req.headers.get("x-forwarded-for");
  if (!header) return UNKNOWN_CLIENT_IP;
  const hops = header
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : UNKNOWN_CLIENT_IP;
}

/**
 * One `auth.scope_denied` row per key per minute, with the attempts it stood
 * in for counted on the next row rather than dropped.
 *
 * A scope denial is worth recording, but recording every one of them isn't
 * bounded by anything: `createApiKeySchema` requires only one scope, so the
 * weakest issuable key — `agents:read` — can loop `DELETE /api/v1/agents/x`
 * and mint an audit row per request. Nothing stops it. The plugin's per-key
 * limiter is off (lib/auth.ts), and Better Auth's own limiter lives in its
 * router's onRequest, which `/api/v1/*` never enters: `withApiKey` reaches
 * `verifyApiKey` through `auth.api.*`, bypassing the router.
 *
 * That is the same unbounded-write problem the 401 branch below refuses to
 * take on, one authentication step later — and it buries the same thing: the
 * genuine denials. A stolen read-only key being probed is precisely what this
 * row exists to catch, and precisely what a flood would drown.
 *
 * Per-process state, like `audit-deferred`'s failure counter, and bounded by
 * the number of keys the process has seen rather than by request volume.
 * Pinchy runs a single Node process per container; a restart just re-opens
 * every window, which costs one extra row per key.
 */
const SCOPE_DENIAL_WINDOW_MS = 60_000;
const scopeDenialWindows = new Map<string, { openedAt: number; suppressed: number }>();

/** Test seam — windows are process-global, so suites must start from zero. */
export function resetScopeDenialWindows(): void {
  scopeDenialWindows.clear();
}

/**
 * Claims the window's single write slot. Returns how many denials were
 * suppressed since the last row when it grants one, so the trail reports the
 * volume it collapsed instead of quietly losing it.
 */
function claimScopeDenialSlot(keyId: string, now: number): { write: boolean; suppressed: number } {
  const open = scopeDenialWindows.get(keyId);
  if (open && now - open.openedAt < SCOPE_DENIAL_WINDOW_MS) {
    open.suppressed++;
    return { write: false, suppressed: open.suppressed };
  }
  scopeDenialWindows.set(keyId, { openedAt: now, suppressed: 0 });
  return { write: true, suppressed: open?.suppressed ?? 0 };
}

/**
 * Denies an unauthenticated attempt — no key header, or a key that failed
 * verification (unknown, expired, disabled, revoked). Ordinarily 401
 * (unchanged), UNLESS the caller's IP has exhausted its invalid-attempt
 * budget (#1086 — `@/lib/api-key-rate-limiter`), in which case it's 429
 * instead: brute-force / key-guessing protection, since the apiKey plugin's
 * own limiter is off (`@/lib/auth`) and Better Auth's general limiter never
 * applies here (verifyApiKey bypasses its router).
 *
 * A plain invalid attempt stays unaudited, same as always: anyone on the
 * internet can present a garbage key, so auditing every one would hand an
 * unauthenticated attacker an unbounded write into the audit table. Once
 * the caller is actually THROTTLED, the write is no longer unbounded — one
 * row per window across the whole path, the shape `claimHostBlockSlot`
 * (`@/server/host-check`) uses for the same reason. Not one row per IP:
 * that window would be keyed on a value the caller supplies, which is how
 * a throttle stops throttling.
 */
async function denyInvalidApiKeyAttempt(req: NextRequest): Promise<NextResponse> {
  const ip = readClientIp(req);
  const now = Date.now();
  if (tryAcquireInvalidApiKeyIpSlot(ip, now)) {
    return unauthorized();
  }

  const slot = claimInvalidApiKeyRateLimitAuditSlot(now);
  if (slot.write) {
    try {
      await appendAuditLog({
        actorType: "system",
        actorId: "system",
        eventType: "auth.rate_limited",
        outcome: "failure",
        detail: {
          reason: "invalid_api_key",
          remoteAddress: ip,
          path: safeAuditPath(new URL(req.url).pathname),
          ...(slot.suppressed > 0 ? { suppressedSinceLastEntry: slot.suppressed } : {}),
        },
      });
    } catch {
      // Don't let a broken audit DB turn a clean 429 into a 500.
    }
  }
  return tooManyRequests(INVALID_API_KEY_RATE_LIMIT_WINDOW_MS / 1000);
}

/**
 * Denies a verified key that has exhausted its own request budget (#1086)
 * — the Pinchy-side replacement for the apiKey plugin's own limiter, off
 * because its 10-req/24h default would throttle a legitimately busy CI
 * pipeline or provisioning script (see `@/lib/auth`). 429, with the same
 * bounded-audit shape as the scope-denial slot: one row per key per window.
 */
async function denyApiKeyRateLimited(
  req: NextRequest,
  key: { id: string; name?: string | null }
): Promise<NextResponse> {
  const now = Date.now();
  const slot = claimApiKeyRateLimitAuditSlot(key.id, now);
  if (slot.write) {
    try {
      await appendAuditLog({
        actorType: "api_key",
        actorId: key.id,
        eventType: "auth.rate_limited",
        outcome: "failure",
        detail: {
          apiKey: { id: key.id, name: key.name ?? "" },
          reason: "api_key",
          path: safeAuditPath(new URL(req.url).pathname),
          ...(slot.suppressed > 0 ? { suppressedSinceLastEntry: slot.suppressed } : {}),
        },
      });
    } catch {
      // Don't let a broken audit DB turn a clean 429 into a 500.
    }
  }
  return tooManyRequests(API_KEY_RATE_LIMIT_WINDOW_MS / 1000);
}

/**
 * Wraps a route handler behind API-key authentication + scope authorization.
 * Programmatic clients (Agent Provisioning API, #572) present a `pinchy_`
 * key instead of a session cookie.
 *
 * Fail-closed on every path — the handler runs only for a verified key that
 * holds *all* `required` scopes:
 *   - no key header                     → 401 Unauthorized (429 if the
 *     caller's IP has exhausted its invalid-attempt budget, #1086)
 *   - key fails verification / no key   → 401 Unauthorized (covers a revoked,
 *     expired or disabled key: the plugin reports those as `valid: false`;
 *     same 429 fallback as above)
 *   - `verifyApiKey` unexpectedly throws → 401 Unauthorized (never open)
 *   - key has exhausted its own request budget → 429 Too Many Requests,
 *     bounded-audited (#1086)
 *   - missing a required scope          → 403 Forbidden, audited
 *
 * A 429 from either limiter carries a `Retry-After` header naming the
 * window in seconds. See `@/lib/api-key-rate-limiter` for the limits
 * themselves and why they're two independent limiters.
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
    if (!key) return denyInvalidApiKeyAttempt(req);

    // Fail closed: `verifyApiKey` catches internally today, but a malformed
    // input or a future plugin version must never fall through as
    // authenticated. `.catch(() => null)` collapses any throw to a denial.
    const res = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
    if (!res?.valid || !res.key) return denyInvalidApiKeyAttempt(req);

    // Per-key volume cap (#1086), checked before scope authorization so a
    // busy or compromised key's blast radius is bounded regardless of what
    // it's scoped for.
    if (!tryAcquireApiKeySlot(res.key.id, Date.now())) {
      return denyApiKeyRateLimited(req, res.key);
    }

    const scopes = extractScopes(res.key.permissions);
    if (!required.every((s) => scopes.includes(s))) {
      // A verified key reaching past its grants is worth a row: it's either a
      // misconfigured client or a stolen key being probed, and telling those
      // apart later needs the attempt on record. Rate-limited per key — see
      // claimScopeDenialSlot for why a real key bounds nothing on its own.
      //
      // The 401s above get no row at all, deliberately. Anyone on the internet
      // can present a garbage key, so auditing them would hand an
      // unauthenticated attacker a write into the audit table — and unlike
      // here there is no id to throttle on, or to attribute the row to.
      //
      // Awaited, not fire-and-forget: `after()` isn't available on every
      // runtime path this wrapper serves, and a denial is cheap. try/catch
      // (the same shape lib/auth.ts uses for auth.failed) keeps a broken
      // audit DB from turning a clean 403 into an unhandled 500 — logging
      // must never gate authorization, in either direction.
      const slot = claimScopeDenialSlot(res.key.id, Date.now());
      if (slot.write) {
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
              // Capped: this is the one field a caller sizes. truncateDetail
              // replaces the WHOLE detail object rather than trimming a field,
              // so an over-long path would take the apiKey snapshot with it and
              // leave the row unattributable — on exactly the rows that
              // document a key being probed.
              path: safeAuditPath(new URL(req.url).pathname),
              // What this row stands in for. A silent cap would read as "one
              // stray call" when it was a thousand.
              ...(slot.suppressed > 0 ? { suppressedSinceLastEntry: slot.suppressed } : {}),
            },
          });
        } catch {
          // Don't break authorization if audit logging fails.
        }
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
