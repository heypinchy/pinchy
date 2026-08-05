import { describe, it, expect } from "vitest";
import { FixedWindowRateLimiter } from "@/lib/fixed-window-rate-limiter";

describe("FixedWindowRateLimiter", () => {
  it("allows calls up to the configured max", () => {
    const limiter = new FixedWindowRateLimiter({ max: 3, windowMs: 1000 });
    const now = 1_000_000;

    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
    expect(limiter.tryAcquire(now)).toBe(true);
  });

  it("rejects further calls once the window is full", () => {
    const limiter = new FixedWindowRateLimiter({ max: 2, windowMs: 1000 });
    const now = 1_000_000;

    limiter.tryAcquire(now);
    limiter.tryAcquire(now);

    expect(limiter.tryAcquire(now)).toBe(false);
    expect(limiter.tryAcquire(now + 500)).toBe(false);
  });

  it("opens a fresh window after windowMs elapses", () => {
    // Fresh windows are the whole point of a fixed-window limiter —
    // without this, a single burst would block the endpoint forever.
    const limiter = new FixedWindowRateLimiter({ max: 2, windowMs: 1000 });
    const start = 1_000_000;

    limiter.tryAcquire(start);
    limiter.tryAcquire(start);
    expect(limiter.tryAcquire(start + 500)).toBe(false);

    // One millisecond past the window — new window starts, call is allowed.
    expect(limiter.tryAcquire(start + 1001)).toBe(true);
  });

  it("reset() empties the current window", () => {
    // Reset exists purely for tests — keeps the singleton in route handlers
    // deterministic between test cases without juggling fake timers.
    const limiter = new FixedWindowRateLimiter({ max: 1, windowMs: 1000 });
    const now = 1_000_000;

    limiter.tryAcquire(now);
    expect(limiter.tryAcquire(now)).toBe(false);

    limiter.reset();
    expect(limiter.tryAcquire(now)).toBe(true);
  });

  it("defaults `now` to Date.now() when called without arguments", () => {
    // The route handler calls tryAcquire() without passing a clock —
    // make sure that still works.
    const limiter = new FixedWindowRateLimiter({ max: 1, windowMs: 1000 });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
  });

  describe("isExpired", () => {
    // Callers that keep ONE limiter PER caller in a Map (api-key-rate-limiter's
    // per-IP buckets) need to know when dropping an instance is
    // behaviour-preserving. That is exactly the condition tryAcquire uses to
    // open a fresh window, so the two must be the same predicate — a looser
    // isExpired would evict a limiter that still holds a live count, which is
    // a rate-limit bypass rather than a cleanup.
    it("reports a limiter as expired exactly when the next tryAcquire would reset it", () => {
      const limiter = new FixedWindowRateLimiter({ max: 1, windowMs: 1000 });
      const start = 1_000_000;

      limiter.tryAcquire(start);
      expect(limiter.isExpired(start)).toBe(false);
      expect(limiter.isExpired(start + 1000)).toBe(false);
      expect(limiter.tryAcquire(start + 1000)).toBe(false);

      expect(limiter.isExpired(start + 1001)).toBe(true);
      expect(limiter.tryAcquire(start + 1001)).toBe(true);
    });

    it("stays expired while the window is exhausted but elapsed", () => {
      const limiter = new FixedWindowRateLimiter({ max: 2, windowMs: 1000 });
      const start = 1_000_000;

      limiter.tryAcquire(start);
      limiter.tryAcquire(start);
      expect(limiter.isExpired(start + 500)).toBe(false);
      expect(limiter.isExpired(start + 5000)).toBe(true);
    });
  });
});
