/**
 * Per-user rate limiter for POST /api/users/me/password.
 *
 * Better Auth's own `/change-password` rule (5 req / 10 min, see
 * `getAuthRateLimitConfig()` in `@/lib/auth`) never applies to this route:
 * the handler calls `auth.api.changePassword` directly, which reaches the
 * endpoint through `auth.api.*` and bypasses the HTTP router whose
 * `onRequest` hosts Better Auth's rate limiter — the same bypass documented
 * in `@/lib/api-auth` for `/api/v1/*`. Without a limiter here, a session
 * holder (their own, or one lifted via XSS/session theft) can brute-force
 * `currentPassword` without limit.
 *
 * Bucketed per user id, unlike `usage-record-rate-limiter.ts`'s single
 * shared bucket: a shared bucket would let one abusive account exhaust the
 * budget for every other user changing their password at the same time.
 *
 * Process-global `Map`, like `scopeDenialWindows` in `@/lib/api-auth` —
 * bounded by the number of distinct users the process has seen rather than
 * by request volume, and a container restart just re-opens every window.
 */

import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

export const PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS = 5;
// 10 minutes — mirrors the (bypassed) Better Auth `/change-password` window
// in `@/lib/auth`, so the effective policy matches the documented one.
export const PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS = 600_000;
/**
 * The same window in whole minutes, for the message the blocked user reads.
 * Derived rather than typed out again, for the reason `@/lib/auth-rate-limit`
 * states about the sign-in window: the enforcing rule and the sentence that
 * quotes it must not be two independent copies of the same number.
 */
export const PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MINUTES =
  PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS / 60_000;

const limiters = new Map<string, FixedWindowRateLimiter>();

/** Returns `true` if the attempt is allowed, `false` if the user's window is full. */
export function tryAcquirePasswordChangeSlot(userId: string, now: number = Date.now()): boolean {
  let limiter = limiters.get(userId);
  if (!limiter) {
    limiter = new FixedWindowRateLimiter({
      max: PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS,
      windowMs: PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS,
    });
    limiters.set(userId, limiter);
  }
  return limiter.tryAcquire(now);
}

/**
 * One `auth.password_changed` (outcome: failure) row per user per rate-limit
 * window, with the attempts it stood in for counted on the next row rather
 * than dropped. Same shape as `claimScopeDenialSlot` in `@/lib/api-auth`:
 * a brute-force loop would otherwise mint one audit row per rejected
 * request, burying the genuine denial the trail exists to catch.
 */
const auditWindows = new Map<string, { openedAt: number; suppressed: number }>();

/**
 * Claims the audit window's single write slot. Returns how many rate-limit
 * denials were suppressed since the last row when it grants one.
 */
export function claimPasswordChangeRateLimitAuditSlot(
  userId: string,
  now: number = Date.now()
): { write: boolean; suppressed: number } {
  const open = auditWindows.get(userId);
  if (open && now - open.openedAt < PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS) {
    open.suppressed++;
    return { write: false, suppressed: open.suppressed };
  }
  auditWindows.set(userId, { openedAt: now, suppressed: 0 });
  return { write: true, suppressed: open?.suppressed ?? 0 };
}

/** Test seam — windows are process-global, so suites must start from zero. */
export function resetPasswordChangeRateLimiterForTest(): void {
  limiters.clear();
  auditWindows.clear();
}
