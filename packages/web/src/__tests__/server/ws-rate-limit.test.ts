import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WsRateLimiter } from "@/server/ws-rate-limit";

describe("WsRateLimiter", () => {
  describe("per-user connection limits", () => {
    it("allows connections up to the max per user", () => {
      const limiter = new WsRateLimiter({ maxConnectionsPerUser: 3 });

      expect(limiter.allowConnection("user-1")).toBe(true);
      limiter.trackConnection("user-1");
      expect(limiter.allowConnection("user-1")).toBe(true);
      limiter.trackConnection("user-1");
      expect(limiter.allowConnection("user-1")).toBe(true);
      limiter.trackConnection("user-1");

      // 4th connection should be rejected
      expect(limiter.allowConnection("user-1")).toBe(false);
    });

    it("tracks connections independently per user", () => {
      const limiter = new WsRateLimiter({ maxConnectionsPerUser: 2 });

      limiter.trackConnection("user-1");
      limiter.trackConnection("user-1");

      // user-1 is full, but user-2 should still be allowed
      expect(limiter.allowConnection("user-1")).toBe(false);
      expect(limiter.allowConnection("user-2")).toBe(true);
    });

    it("frees a slot when a connection is released", () => {
      const limiter = new WsRateLimiter({ maxConnectionsPerUser: 1 });

      limiter.trackConnection("user-1");
      expect(limiter.allowConnection("user-1")).toBe(false);

      limiter.releaseConnection("user-1");
      expect(limiter.allowConnection("user-1")).toBe(true);
    });

    it("does not go below zero on extra release calls", () => {
      const limiter = new WsRateLimiter({ maxConnectionsPerUser: 1 });

      limiter.releaseConnection("user-1"); // no-op
      limiter.releaseConnection("user-1"); // no-op

      expect(limiter.allowConnection("user-1")).toBe(true);
    });
  });

  describe("per-IP upgrade rate limiting", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("allows upgrades up to the rate limit within the window", () => {
      const limiter = new WsRateLimiter({
        maxUpgradesPerIpPerMinute: 3,
      });

      expect(limiter.allowUpgrade("192.168.1.1")).toBe(true);
      expect(limiter.allowUpgrade("192.168.1.1")).toBe(true);
      expect(limiter.allowUpgrade("192.168.1.1")).toBe(true);

      // 4th upgrade within the window should be rejected
      expect(limiter.allowUpgrade("192.168.1.1")).toBe(false);
    });

    it("resets the counter after the time window expires", () => {
      const limiter = new WsRateLimiter({
        maxUpgradesPerIpPerMinute: 2,
      });

      expect(limiter.allowUpgrade("10.0.0.1")).toBe(true);
      expect(limiter.allowUpgrade("10.0.0.1")).toBe(true);
      expect(limiter.allowUpgrade("10.0.0.1")).toBe(false);

      // Advance time past the 1-minute window
      vi.advanceTimersByTime(60_001);

      expect(limiter.allowUpgrade("10.0.0.1")).toBe(true);
    });

    it("tracks IPs independently", () => {
      const limiter = new WsRateLimiter({
        maxUpgradesPerIpPerMinute: 1,
      });

      expect(limiter.allowUpgrade("10.0.0.1")).toBe(true);
      expect(limiter.allowUpgrade("10.0.0.1")).toBe(false);

      // Different IP should still be allowed
      expect(limiter.allowUpgrade("10.0.0.2")).toBe(true);
    });
  });
});
