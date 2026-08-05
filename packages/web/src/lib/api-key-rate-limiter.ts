/**
 * In-process rate limiting for `/api/v1/*` (Agent Provisioning API, #572),
 * wired into `withApiKey` (`@/lib/api-auth`).
 *
 * `lib/auth.ts` turns off the apiKey plugin's own per-key limiter (its
 * default — 10 req/24h — would throttle a legitimately busy CI pipeline),
 * and Better Auth's general-purpose limiter never applies either: it guards
 * the Better Auth HTTP router's `onRequest`, and `/api/v1/*` reaches key
 * verification through a direct `auth.api.verifyApiKey` call that bypasses
 * the router entirely. Until now that left the surface documented as "a gap,
 * not a delegation" with nothing enforcing it (#1086).
 *
 * Two independent limiters, because they guard two different things:
 *
 *  - **Per key** (`tryAcquireApiKeySlot`) bounds a VERIFIED key's request
 *    volume — generous, so a legitimate automation client is never
 *    throttled in practice, but bounded so a compromised or malfunctioning
 *    key can't hammer the API without limit.
 *  - **Per IP** (`tryAcquireInvalidApiKeyIpSlot`) bounds INVALID-key
 *    attempts — brute-force / key-guessing protection. Strict: nobody
 *    legitimately fails key auth more than a handful of times per minute
 *    (a stale key, a typo). There's no key id to bucket on for a garbage
 *    credential, so this buckets on the caller's IP instead (see
 *    `readClientIp` in `@/lib/api-auth`).
 *
 * Same shape as `@/lib/password-change-rate-limiter` and the scope-denial
 * windows in `@/lib/api-auth`: process-global state, and a container restart
 * just re-opens every window.
 *
 * The two halves are NOT symmetric, and the asymmetry is the point. Those
 * precedents key their `Map` on a user id or an API key id — an identity an
 * admin has to mint first, so "bounded by the distinct identities the
 * process has seen" is a real bound. A client address is not that: an
 * unauthenticated caller picks it, IPv6 hands one host a /64 to rotate
 * through, and behind no proxy it is a header the caller writes itself. So
 * for the invalid-key half:
 *
 *  - the LIMITER map is still keyed per address (one noisy source must not
 *    lock out everyone else), but it evicts elapsed buckets and fails closed
 *    at a hard cap instead of growing per request;
 *  - the AUDIT window is GLOBAL, not keyed at all — AGENTS.md
 *    § "`/api/internal/` Is A Security Claim, Not A Folder Name" states the
 *    rule and `claimHostBlockSlot` (`@/server/host-check`) is the precedent:
 *    every `appendAuditLog` takes `pg_advisory_xact_lock` on one constant
 *    key, so an audit window keyed on a caller-supplied value doesn't just
 *    grow a table — it serializes every genuine audit write in the process
 *    behind the flood.
 */

import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

// ── Per-key limit (valid keys) ──────────────────────────────────────────

/**
 * 300 requests / minute per key (5 req/s sustained, with a full-window
 * burst allowance). Deliberately generous — the point is to bound a
 * runaway or compromised key, not to throttle a busy provisioning script,
 * which is exactly the failure mode that made the plugin's own 10-req/24h
 * default unusable here.
 */
export const API_KEY_RATE_LIMIT_MAX_REQUESTS = 300;
export const API_KEY_RATE_LIMIT_WINDOW_MS = 60_000;

const apiKeyLimiters = new Map<string, FixedWindowRateLimiter>();

/** Returns `true` if the request is allowed, `false` if the key's window is full. */
export function tryAcquireApiKeySlot(keyId: string, now: number = Date.now()): boolean {
  let limiter = apiKeyLimiters.get(keyId);
  if (!limiter) {
    limiter = new FixedWindowRateLimiter({
      max: API_KEY_RATE_LIMIT_MAX_REQUESTS,
      windowMs: API_KEY_RATE_LIMIT_WINDOW_MS,
    });
    apiKeyLimiters.set(keyId, limiter);
  }
  return limiter.tryAcquire(now);
}

/**
 * One `auth.rate_limited` row per key per window, with the requests it
 * stood in for counted on the next row rather than dropped. Same shape as
 * `claimScopeDenialSlot` in `@/lib/api-auth`: without this, a client that
 * keeps hammering a throttled key would mint one audit row per rejected
 * request instead of one per window.
 */
const apiKeyRateLimitAuditWindows = new Map<string, { openedAt: number; suppressed: number }>();

export function claimApiKeyRateLimitAuditSlot(
  keyId: string,
  now: number = Date.now()
): { write: boolean; suppressed: number } {
  const open = apiKeyRateLimitAuditWindows.get(keyId);
  if (open && now - open.openedAt < API_KEY_RATE_LIMIT_WINDOW_MS) {
    open.suppressed++;
    return { write: false, suppressed: open.suppressed };
  }
  apiKeyRateLimitAuditWindows.set(keyId, { openedAt: now, suppressed: 0 });
  return { write: true, suppressed: open?.suppressed ?? 0 };
}

// ── Per-IP limit (invalid-key attempts) ─────────────────────────────────

/**
 * 20 attempts / minute per IP. Strict, because this bucket only ever fills
 * with requests that never verified — a missing key, an unknown key, an
 * expired/disabled/revoked one — which is precisely the brute-force /
 * key-guessing shape this guards against, not legitimate traffic.
 */
export const INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS = 20;
export const INVALID_API_KEY_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Ceiling on how many addresses are tracked at once. Unlike the per-key map,
 * this one's key space belongs to the caller, so "one entry per distinct
 * address" is not a bound — a single host with an IPv6 /64 can mint them
 * faster than the sweep below reclaims them.
 *
 * At the cap a NEW address gets no bucket and is denied. That direction is
 * not arbitrary: handing back `true` because the process is out of room
 * would turn memory pressure into "you are allowed", which is exactly the
 * bypass the cap exists to prevent. An address already tracked keeps its own
 * budget, so a flood cannot use the cap to un-throttle itself either.
 */
export const INVALID_API_KEY_IP_MAX_TRACKED = 50_000;

const invalidApiKeyIpLimiters = new Map<string, FixedWindowRateLimiter>();

/**
 * Elapsed buckets are dead weight: a limiter past its window enforces
 * nothing, since the next `tryAcquire` opens a fresh one either way (hence
 * `isExpired` being the same predicate — see `@/lib/fixed-window-rate-limiter`).
 *
 * Swept at most once per window rather than on every insert. A sweep is O(n)
 * over the map, and running it per request above some size threshold would
 * hand the flood a CPU cost to drive instead of a memory one.
 */
let nextInvalidApiKeyIpSweepAt = 0;

function sweepInvalidApiKeyIpBuckets(now: number): void {
  if (now < nextInvalidApiKeyIpSweepAt) return;
  nextInvalidApiKeyIpSweepAt = now + INVALID_API_KEY_RATE_LIMIT_WINDOW_MS;
  for (const [ip, limiter] of invalidApiKeyIpLimiters) {
    if (limiter.isExpired(now)) invalidApiKeyIpLimiters.delete(ip);
  }
}

/** Returns `true` if the attempt is allowed, `false` if the IP's window is full. */
export function tryAcquireInvalidApiKeyIpSlot(ip: string, now: number = Date.now()): boolean {
  sweepInvalidApiKeyIpBuckets(now);

  let limiter = invalidApiKeyIpLimiters.get(ip);
  if (!limiter) {
    if (invalidApiKeyIpLimiters.size >= INVALID_API_KEY_IP_MAX_TRACKED) return false;
    limiter = new FixedWindowRateLimiter({
      max: INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: INVALID_API_KEY_RATE_LIMIT_WINDOW_MS,
    });
    invalidApiKeyIpLimiters.set(ip, limiter);
  }
  return limiter.tryAcquire(now);
}

/** Test seam — the map is process-global, so suites must start from zero. */
export function trackedInvalidApiKeyIpCountForTest(): number {
  return invalidApiKeyIpLimiters.size;
}

/**
 * One `auth.rate_limited` row per window for the invalid-key path — GLOBAL,
 * not keyed by address, and that is the load-bearing difference from
 * `claimApiKeyRateLimitAuditSlot` above.
 *
 * Bounding this is what makes it safe to audit an unauthenticated caller at
 * all: an ordinary garbage credential is still NOT audited (see
 * `@/lib/api-auth`'s 401 branch — an unauthenticated caller must not get a
 * write into the audit table for free). Keying the window on the address
 * would reinstate exactly that: one row per source, and a distributed
 * key-guessing sweep mints as many sources as it likes. AGENTS.md
 * § "`/api/internal/` Is A Security Claim, Not A Folder Name" writes the rule
 * down after `auth.host_blocked` hit it — a window keyed on a caller-supplied
 * value "grows per request and the throttle stops throttling" — and
 * `claimHostBlockSlot` (`@/server/host-check`) is the shape to copy. The
 * per-key window above may stay keyed for the reason stated there: an admin
 * has to mint an API key first.
 *
 * The cost is real and accepted, same as for `auth.host_blocked`: inside one
 * minute a flood from one source can mask a throttle from another. The row
 * that does get written still names its own `remoteAddress`, and
 * `suppressedSinceLastEntry` reports the scale.
 */
let invalidApiKeyRateLimitAuditWindow: { openedAt: number; suppressed: number } | null = null;

export function claimInvalidApiKeyRateLimitAuditSlot(now: number = Date.now()): {
  write: boolean;
  suppressed: number;
} {
  const open = invalidApiKeyRateLimitAuditWindow;
  if (open && now - open.openedAt < INVALID_API_KEY_RATE_LIMIT_WINDOW_MS) {
    open.suppressed++;
    return { write: false, suppressed: open.suppressed };
  }
  const suppressed = open?.suppressed ?? 0;
  invalidApiKeyRateLimitAuditWindow = { openedAt: now, suppressed: 0 };
  return { write: true, suppressed };
}

/** Test seam — every window here is process-global, so suites must start from zero. */
export function resetApiKeyRateLimitersForTest(): void {
  apiKeyLimiters.clear();
  apiKeyRateLimitAuditWindows.clear();
  invalidApiKeyIpLimiters.clear();
  nextInvalidApiKeyIpSweepAt = 0;
  invalidApiKeyRateLimitAuditWindow = null;
}
