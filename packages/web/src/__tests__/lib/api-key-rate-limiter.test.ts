import { describe, it, expect, beforeEach } from "vitest";
import {
  tryAcquireApiKeySlot,
  claimApiKeyRateLimitAuditSlot,
  API_KEY_RATE_LIMIT_MAX_REQUESTS,
  API_KEY_RATE_LIMIT_WINDOW_MS,
  tryAcquireInvalidApiKeyIpSlot,
  claimInvalidApiKeyRateLimitAuditSlot,
  INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS,
  INVALID_API_KEY_RATE_LIMIT_WINDOW_MS,
  resetApiKeyRateLimitersForTest,
} from "@/lib/api-key-rate-limiter";

describe("api-key-rate-limiter", () => {
  beforeEach(() => {
    resetApiKeyRateLimitersForTest();
  });

  describe("tryAcquireApiKeySlot (per verified key)", () => {
    it("allows up to the configured max requests per key within the window", () => {
      const now = 1_000_000;
      for (let i = 0; i < API_KEY_RATE_LIMIT_MAX_REQUESTS; i++) {
        expect(tryAcquireApiKeySlot("key-1", now)).toBe(true);
      }
    });

    it("rejects the request after the max is exhausted within the window", () => {
      const now = 1_000_000;
      for (let i = 0; i < API_KEY_RATE_LIMIT_MAX_REQUESTS; i++) {
        tryAcquireApiKeySlot("key-1", now);
      }
      expect(tryAcquireApiKeySlot("key-1", now)).toBe(false);
    });

    it("tracks each key's window independently", () => {
      const now = 1_000_000;
      for (let i = 0; i < API_KEY_RATE_LIMIT_MAX_REQUESTS; i++) {
        tryAcquireApiKeySlot("key-1", now);
      }
      expect(tryAcquireApiKeySlot("key-1", now)).toBe(false);
      // A different key must not be affected by key-1's exhausted window.
      expect(tryAcquireApiKeySlot("key-2", now)).toBe(true);
    });

    it("opens a fresh window once API_KEY_RATE_LIMIT_WINDOW_MS elapses", () => {
      const start = 1_000_000;
      for (let i = 0; i < API_KEY_RATE_LIMIT_MAX_REQUESTS; i++) {
        tryAcquireApiKeySlot("key-1", start);
      }
      expect(tryAcquireApiKeySlot("key-1", start)).toBe(false);

      expect(tryAcquireApiKeySlot("key-1", start + API_KEY_RATE_LIMIT_WINDOW_MS + 1)).toBe(true);
    });
  });

  describe("claimApiKeyRateLimitAuditSlot", () => {
    it("grants the first write and returns zero suppressed", () => {
      expect(claimApiKeyRateLimitAuditSlot("key-1", 1_000_000)).toEqual({
        write: true,
        suppressed: 0,
      });
    });

    it("suppresses further claims within the same window and counts them", () => {
      const now = 1_000_000;
      claimApiKeyRateLimitAuditSlot("key-1", now);

      expect(claimApiKeyRateLimitAuditSlot("key-1", now + 1)).toEqual({
        write: false,
        suppressed: 1,
      });
      expect(claimApiKeyRateLimitAuditSlot("key-1", now + 2)).toEqual({
        write: false,
        suppressed: 2,
      });
    });

    it("opens a new window and reports the prior suppressed count once it elapses", () => {
      const start = 1_000_000;
      claimApiKeyRateLimitAuditSlot("key-1", start);
      claimApiKeyRateLimitAuditSlot("key-1", start + 1);
      claimApiKeyRateLimitAuditSlot("key-1", start + 2);

      expect(
        claimApiKeyRateLimitAuditSlot("key-1", start + API_KEY_RATE_LIMIT_WINDOW_MS + 1)
      ).toEqual({
        write: true,
        suppressed: 2,
      });
    });

    it("tracks each key's audit window independently", () => {
      const now = 1_000_000;
      claimApiKeyRateLimitAuditSlot("key-1", now);
      expect(claimApiKeyRateLimitAuditSlot("key-2", now)).toEqual({ write: true, suppressed: 0 });
    });
  });

  describe("tryAcquireInvalidApiKeyIpSlot (per IP, invalid-key attempts)", () => {
    it("allows up to the configured max attempts per IP within the window", () => {
      const now = 1_000_000;
      for (let i = 0; i < INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS; i++) {
        expect(tryAcquireInvalidApiKeyIpSlot("1.2.3.4", now)).toBe(true);
      }
    });

    it("rejects the attempt after the max is exhausted within the window", () => {
      const now = 1_000_000;
      for (let i = 0; i < INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS; i++) {
        tryAcquireInvalidApiKeyIpSlot("1.2.3.4", now);
      }
      expect(tryAcquireInvalidApiKeyIpSlot("1.2.3.4", now)).toBe(false);
    });

    it("tracks each IP's window independently — one noisy IP can't lock out another", () => {
      const now = 1_000_000;
      for (let i = 0; i < INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS; i++) {
        tryAcquireInvalidApiKeyIpSlot("1.2.3.4", now);
      }
      expect(tryAcquireInvalidApiKeyIpSlot("1.2.3.4", now)).toBe(false);
      expect(tryAcquireInvalidApiKeyIpSlot("5.6.7.8", now)).toBe(true);
    });

    it("opens a fresh window once INVALID_API_KEY_RATE_LIMIT_WINDOW_MS elapses", () => {
      const start = 1_000_000;
      for (let i = 0; i < INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS; i++) {
        tryAcquireInvalidApiKeyIpSlot("1.2.3.4", start);
      }
      expect(tryAcquireInvalidApiKeyIpSlot("1.2.3.4", start)).toBe(false);

      expect(
        tryAcquireInvalidApiKeyIpSlot("1.2.3.4", start + INVALID_API_KEY_RATE_LIMIT_WINDOW_MS + 1)
      ).toBe(true);
    });
  });

  describe("claimInvalidApiKeyRateLimitAuditSlot", () => {
    it("grants the first write and returns zero suppressed", () => {
      expect(claimInvalidApiKeyRateLimitAuditSlot("1.2.3.4", 1_000_000)).toEqual({
        write: true,
        suppressed: 0,
      });
    });

    it("suppresses further claims within the same window and counts them", () => {
      const now = 1_000_000;
      claimInvalidApiKeyRateLimitAuditSlot("1.2.3.4", now);

      expect(claimInvalidApiKeyRateLimitAuditSlot("1.2.3.4", now + 1)).toEqual({
        write: false,
        suppressed: 1,
      });
    });

    it("tracks each IP's audit window independently", () => {
      const now = 1_000_000;
      claimInvalidApiKeyRateLimitAuditSlot("1.2.3.4", now);
      expect(claimInvalidApiKeyRateLimitAuditSlot("5.6.7.8", now)).toEqual({
        write: true,
        suppressed: 0,
      });
    });
  });
});
