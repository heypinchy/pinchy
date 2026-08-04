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
 * windows in `@/lib/api-auth`: process-global `Map`s, bounded by the number
 * of distinct keys/IPs the process has seen rather than by request volume.
 * A container restart just re-opens every window.
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

const invalidApiKeyIpLimiters = new Map<string, FixedWindowRateLimiter>();

/** Returns `true` if the attempt is allowed, `false` if the IP's window is full. */
export function tryAcquireInvalidApiKeyIpSlot(ip: string, now: number = Date.now()): boolean {
  let limiter = invalidApiKeyIpLimiters.get(ip);
  if (!limiter) {
    limiter = new FixedWindowRateLimiter({
      max: INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: INVALID_API_KEY_RATE_LIMIT_WINDOW_MS,
    });
    invalidApiKeyIpLimiters.set(ip, limiter);
  }
  return limiter.tryAcquire(now);
}

/**
 * One `auth.rate_limited` row per IP per window. Bounding this is what
 * makes it safe to audit an invalid-key attempt at all: an ordinary garbage
 * credential is still NOT audited (see `@/lib/api-auth`'s 401 branch — an
 * unauthenticated caller must not get a write into the audit table for
 * free), but once an IP has been throttled that ceases to be an
 * unbounded write — it's one row per window, exactly like the per-key case
 * above.
 */
const invalidApiKeyRateLimitAuditWindows = new Map<
  string,
  { openedAt: number; suppressed: number }
>();

export function claimInvalidApiKeyRateLimitAuditSlot(
  ip: string,
  now: number = Date.now()
): { write: boolean; suppressed: number } {
  const open = invalidApiKeyRateLimitAuditWindows.get(ip);
  if (open && now - open.openedAt < INVALID_API_KEY_RATE_LIMIT_WINDOW_MS) {
    open.suppressed++;
    return { write: false, suppressed: open.suppressed };
  }
  invalidApiKeyRateLimitAuditWindows.set(ip, { openedAt: now, suppressed: 0 });
  return { write: true, suppressed: open?.suppressed ?? 0 };
}

/** Test seam — every map here is process-global, so suites must start from zero. */
export function resetApiKeyRateLimitersForTest(): void {
  apiKeyLimiters.clear();
  apiKeyRateLimitAuditWindows.clear();
  invalidApiKeyIpLimiters.clear();
  invalidApiKeyRateLimitAuditWindows.clear();
}
