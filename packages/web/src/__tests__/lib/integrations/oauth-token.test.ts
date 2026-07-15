import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EXPIRY_BUFFER_MS,
  isTokenExpired,
  computeExpiresAt,
  createRefreshDedup,
} from "@/lib/integrations/oauth-token";

describe("oauth-token", () => {
  // Freeze the clock: isTokenExpired() compares against a fresh Date.now() call,
  // so computing a boundary date and then asserting against real time is racy —
  // any elapsed millisecond between the two Date.now() reads flips the strict
  // inequality and fails the boundary assertion (~1/1800 runs). Freezing time
  // makes both reads observe the exact same instant.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("EXPIRY_BUFFER_MS", () => {
    it("is 5 minutes in milliseconds", () => {
      expect(EXPIRY_BUFFER_MS).toBe(5 * 60 * 1000);
    });
  });

  describe("isTokenExpired", () => {
    it("returns true if expiresAt is in the past", () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      expect(isTokenExpired(pastDate)).toBe(true);
    });

    it("returns false if expiresAt is exactly at the 5-minute buffer boundary", () => {
      // expiresAt - EXPIRY_BUFFER_MS < now is a strict inequality, so the exact
      // boundary (expiresAt - buffer === now) is not yet considered expired.
      const boundaryDate = new Date(Date.now() + EXPIRY_BUFFER_MS).toISOString();
      expect(isTokenExpired(boundaryDate)).toBe(false);
    });

    it("returns true if expiresAt is within the 5-minute buffer", () => {
      const soonDate = new Date(Date.now() + 2 * 60_000).toISOString();
      expect(isTokenExpired(soonDate)).toBe(true);
    });

    it("returns false if expiresAt is just past the 5-minute buffer", () => {
      const justOutsideBuffer = new Date(Date.now() + EXPIRY_BUFFER_MS + 60_000).toISOString();
      expect(isTokenExpired(justOutsideBuffer)).toBe(false);
    });

    it("returns false if expiresAt is well in the future", () => {
      const futureDate = new Date(Date.now() + 30 * 60_000).toISOString();
      expect(isTokenExpired(futureDate)).toBe(false);
    });
  });

  describe("computeExpiresAt", () => {
    it("returns an ISO string expires_in seconds from now", () => {
      const result = computeExpiresAt(3600);
      expect(result).toBe(new Date(Date.now() + 3600 * 1000).toISOString());
    });

    it("throws when expires_in is undefined (field missing from token response)", () => {
      // Every provider parses its token response with a type assertion, not
      // runtime validation (see computeExpiresAt's own comment), so a real
      // response missing expires_in reaches this call as undefined despite
      // the `number` parameter type. Simulate that boundary explicitly.
      expect(() => computeExpiresAt(undefined as unknown as number)).toThrow(/expires_in/);
    });

    it("throws when expires_in is not a number", () => {
      expect(() => computeExpiresAt("3600" as unknown as number)).toThrow(/expires_in/);
    });

    it("throws when expires_in is NaN", () => {
      expect(() => computeExpiresAt(NaN)).toThrow(/expires_in/);
    });

    it("throws when expires_in is negative", () => {
      expect(() => computeExpiresAt(-1)).toThrow(/expires_in/);
    });
  });

  describe("createRefreshDedup", () => {
    it("shares one underlying run() across concurrent calls for the same connectionId", async () => {
      const run = vi.fn().mockResolvedValue("fresh-token");
      const dedupe = createRefreshDedup<string>();

      const [a, b] = await Promise.all([dedupe("conn-1", run), dedupe("conn-1", run)]);

      expect(run).toHaveBeenCalledTimes(1);
      expect(a).toBe("fresh-token");
      expect(b).toBe("fresh-token");
    });

    it("runs independently for different connectionIds", async () => {
      const run1 = vi.fn().mockResolvedValue("token-1");
      const run2 = vi.fn().mockResolvedValue("token-2");
      const dedupe = createRefreshDedup<string>();

      const [a, b] = await Promise.all([dedupe("conn-1", run1), dedupe("conn-2", run2)]);

      expect(run1).toHaveBeenCalledTimes(1);
      expect(run2).toHaveBeenCalledTimes(1);
      expect(a).toBe("token-1");
      expect(b).toBe("token-2");
    });

    it("runs run() again for a subsequent call after the prior call settled", async () => {
      const run = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");
      const dedupe = createRefreshDedup<string>();

      const first = await dedupe("conn-1", run);
      const second = await dedupe("conn-1", run);

      expect(run).toHaveBeenCalledTimes(2);
      expect(first).toBe("token-1");
      expect(second).toBe("token-2");
    });

    it("clears the in-flight entry when run() rejects, so the next call re-runs", async () => {
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error("refresh failed"))
        .mockResolvedValueOnce("token-recovered");
      const dedupe = createRefreshDedup<string>();

      await expect(dedupe("conn-1", run)).rejects.toThrow("refresh failed");
      const second = await dedupe("conn-1", run);

      expect(run).toHaveBeenCalledTimes(2);
      expect(second).toBe("token-recovered");
    });
  });
});
