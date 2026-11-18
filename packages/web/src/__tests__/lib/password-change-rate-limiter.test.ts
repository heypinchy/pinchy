import { describe, it, expect, beforeEach } from "vitest";
import {
  tryAcquirePasswordChangeSlot,
  claimPasswordChangeRateLimitAuditSlot,
  resetPasswordChangeRateLimiterForTest,
  PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS,
  PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS,
} from "@/lib/password-change-rate-limiter";

describe("password-change-rate-limiter", () => {
  beforeEach(() => {
    resetPasswordChangeRateLimiterForTest();
  });

  it("allows up to the configured max attempts per user within the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      expect(tryAcquirePasswordChangeSlot("user-1", now)).toBe(true);
    }
  });

  it("rejects the attempt after the max is exhausted within the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      tryAcquirePasswordChangeSlot("user-1", now);
    }
    expect(tryAcquirePasswordChangeSlot("user-1", now)).toBe(false);
  });

  it("tracks each user's window independently", () => {
    const now = 1_000_000;
    for (let i = 0; i < PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      tryAcquirePasswordChangeSlot("user-1", now);
    }
    expect(tryAcquirePasswordChangeSlot("user-1", now)).toBe(false);
    // A different user must not be affected by user-1's exhausted window.
    expect(tryAcquirePasswordChangeSlot("user-2", now)).toBe(true);
  });

  it("opens a fresh window once PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS elapses", () => {
    const start = 1_000_000;
    for (let i = 0; i < PASSWORD_CHANGE_RATE_LIMIT_MAX_ATTEMPTS; i++) {
      tryAcquirePasswordChangeSlot("user-1", start);
    }
    expect(tryAcquirePasswordChangeSlot("user-1", start)).toBe(false);

    expect(
      tryAcquirePasswordChangeSlot("user-1", start + PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS + 1)
    ).toBe(true);
  });

  describe("claimPasswordChangeRateLimitAuditSlot", () => {
    it("grants the first write and returns zero suppressed", () => {
      const slot = claimPasswordChangeRateLimitAuditSlot("user-1", 1_000_000);
      expect(slot).toEqual({ write: true, suppressed: 0 });
    });

    it("suppresses further claims within the same window and counts them", () => {
      const now = 1_000_000;
      claimPasswordChangeRateLimitAuditSlot("user-1", now);

      const second = claimPasswordChangeRateLimitAuditSlot("user-1", now + 1);
      expect(second).toEqual({ write: false, suppressed: 1 });

      const third = claimPasswordChangeRateLimitAuditSlot("user-1", now + 2);
      expect(third).toEqual({ write: false, suppressed: 2 });
    });

    it("opens a new window and reports the prior suppressed count once it elapses", () => {
      const start = 1_000_000;
      claimPasswordChangeRateLimitAuditSlot("user-1", start);
      claimPasswordChangeRateLimitAuditSlot("user-1", start + 1); // suppressed 1
      claimPasswordChangeRateLimitAuditSlot("user-1", start + 2); // suppressed 2

      const next = claimPasswordChangeRateLimitAuditSlot(
        "user-1",
        start + PASSWORD_CHANGE_RATE_LIMIT_WINDOW_MS + 1
      );
      expect(next).toEqual({ write: true, suppressed: 2 });
    });

    it("tracks each user's audit window independently", () => {
      const now = 1_000_000;
      claimPasswordChangeRateLimitAuditSlot("user-1", now);
      const slot = claimPasswordChangeRateLimitAuditSlot("user-2", now);
      expect(slot).toEqual({ write: true, suppressed: 0 });
    });
  });
});
