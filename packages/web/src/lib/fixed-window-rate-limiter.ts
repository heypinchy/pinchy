/**
 * Minimal in-memory fixed-window rate limiter for single-process API routes.
 *
 * Used by internal endpoints (e.g. `/api/internal/usage/record`) as a
 * defense-in-depth guard: token auth already gates writers, but an unbounded
 * write path is still a liability if a plugin misbehaves or a token leaks.
 *
 * The implementation is deliberately tiny: one counter per limiter instance,
 * with a window reset on the first call after `windowMs` elapses. Tracks are
 * NOT per-client — each limiter is a single global bucket for the route
 * that owns it. That's fine for internal endpoints where all traffic comes
 * from one container; it's not sufficient for public, multi-tenant limits.
 */

export class FixedWindowRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private windowStart = 0;
  private count = 0;

  constructor(options: { max: number; windowMs: number }) {
    this.max = options.max;
    this.windowMs = options.windowMs;
  }

  /**
   * Returns `true` if the request is allowed, `false` if it would exceed
   * the limit. Mutates the internal counter on every allowed call.
   */
  tryAcquire(now: number = Date.now()): boolean {
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.count = 1;
      return true;
    }
    if (this.count >= this.max) {
      return false;
    }
    this.count++;
    return true;
  }

  /** Resets the window. Intended for tests. */
  reset(): void {
    this.windowStart = 0;
    this.count = 0;
  }
}
