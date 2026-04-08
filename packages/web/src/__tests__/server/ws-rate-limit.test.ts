import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { WsRateLimiter } from "@/server/ws-rate-limit";

describe("WsRateLimiter", () => {
  describe("rejection callback", () => {
    it("invokes onReject when an upgrade is denied so the host can log it", () => {
      const onReject = vi.fn();
      const limiter = new WsRateLimiter({
        maxUpgradesPerIpPerMinute: 1,
        onReject,
      });

      limiter.allowUpgrade("10.0.0.1");
      expect(onReject).not.toHaveBeenCalled();

      // Second upgrade in the same window — denied
      const allowed = limiter.allowUpgrade("10.0.0.1");
      expect(allowed).toBe(false);
      expect(onReject).toHaveBeenCalledTimes(1);
      expect(onReject).toHaveBeenCalledWith({
        kind: "upgrade",
        ip: "10.0.0.1",
      });
    });

    it("invokes onReject when a per-user connection is denied", () => {
      const onReject = vi.fn();
      const limiter = new WsRateLimiter({
        maxConnectionsPerUser: 1,
        onReject,
      });

      limiter.trackConnection("user-1");
      const allowed = limiter.allowConnection("user-1");
      expect(allowed).toBe(false);
      expect(onReject).toHaveBeenCalledTimes(1);
      expect(onReject).toHaveBeenCalledWith({
        kind: "connection",
        userId: "user-1",
      });
    });

    it("does not throw if no onReject is configured", () => {
      const limiter = new WsRateLimiter({ maxUpgradesPerIpPerMinute: 1 });
      limiter.allowUpgrade("10.0.0.1");
      expect(() => limiter.allowUpgrade("10.0.0.1")).not.toThrow();
    });
  });

  describe("default limits", () => {
    it("uses defaults that comfortably accommodate legitimate reconnect loops", () => {
      // The frontend reconnects with exponential backoff up to 10 times
      // within ~42s. Single-tab page reloads, agent switches, and brief
      // network blips can stack on top. Defaults must absorb this without
      // tripping the brute-force guard.
      const limiter = new WsRateLimiter();
      const ip = "10.0.0.42";
      // 30 upgrades inside one window must still be allowed by default
      for (let i = 0; i < 30; i++) {
        expect(limiter.allowUpgrade(ip)).toBe(true);
      }
    });

    it("allows several concurrent connections per user by default", () => {
      // Multiple tabs / brief overlap during reconnect must not be blocked
      const limiter = new WsRateLimiter();
      const userId = "user-1";
      for (let i = 0; i < 8; i++) {
        expect(limiter.allowConnection(userId)).toBe(true);
        limiter.trackConnection(userId);
      }
    });
  });

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
