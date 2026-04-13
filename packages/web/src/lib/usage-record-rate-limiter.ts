/**
 * Module-private singleton rate limiter for POST /api/internal/usage/record.
 *
 * Lives outside the route file on purpose: Next.js 16 App Router route modules
 * may only export HTTP method handlers and well-known config symbols. Keeping
 * the limiter (and its test-only reset helper) here keeps the route file
 * conformant while still letting tests drive the window deterministically.
 *
 * The limit is generous enough to absorb a burst of vision API calls from a
 * single PDF read (tens of concurrent calls) but bounded enough to fail fast
 * on abuse. The route applies it BEFORE token validation so brute-forcing the
 * gateway token is also rate-limited.
 */

import { FixedWindowRateLimiter } from "./fixed-window-rate-limiter";

const RATE_LIMIT_MAX_REQUESTS = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;

const limiter = new FixedWindowRateLimiter({
  max: RATE_LIMIT_MAX_REQUESTS,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

/** Returns `true` if the call is allowed, `false` if the window is full. */
export function tryAcquireUsageRecordSlot(now: number = Date.now()): boolean {
  return limiter.tryAcquire(now);
}

/** Resets the window. Intended for tests. */
export function resetUsageRecordRateLimiterForTest(): void {
  limiter.reset();
}
