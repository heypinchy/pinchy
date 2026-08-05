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
  INVALID_API_KEY_IP_MAX_TRACKED,
  trackedInvalidApiKeyIpCountForTest,
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

  describe("invalid-key bucket eviction", () => {
    it("evicts a bucket whose window has elapsed instead of keeping it forever", () => {
      const start = 1_000_000;
      tryAcquireInvalidApiKeyIpSlot("1.2.3.4", start);
      expect(trackedInvalidApiKeyIpCountForTest()).toBe(1);

      // Another IP one full window later. The sweep runs at most once per
      // window, so this call is what triggers it — and 1.2.3.4 has been idle
      // for longer than its own window, so its bucket is dead weight.
      tryAcquireInvalidApiKeyIpSlot("5.6.7.8", start + INVALID_API_KEY_RATE_LIMIT_WINDOW_MS + 1);
      expect(trackedInvalidApiKeyIpCountForTest()).toBe(1);
    });

    it("never evicts a bucket that is still inside its window — eviction is not an escape hatch", () => {
      const start = 1_000_000;
      for (let i = 0; i < INVALID_API_KEY_RATE_LIMIT_MAX_ATTEMPTS; i++) {
        tryAcquireInvalidApiKeyIpSlot("1.2.3.4", start);
      }
      expect(tryAcquireInvalidApiKeyIpSlot("1.2.3.4", start)).toBe(false);

      // Traffic from other IPs keeps arriving and eventually triggers a sweep.
      // The throttled IP is mid-window, so it must survive it and stay denied.
      for (let i = 0; i < 50; i++) {
        tryAcquireInvalidApiKeyIpSlot(`10.0.0.${i}`, start + 1_000 * i);
      }
      expect(
        tryAcquireInvalidApiKeyIpSlot("1.2.3.4", start + INVALID_API_KEY_RATE_LIMIT_WINDOW_MS - 1)
      ).toBe(false);
    });

    it("fails CLOSED once the tracked-bucket cap is reached rather than growing without bound", () => {
      const now = 1_000_000;
      for (let i = 0; i < INVALID_API_KEY_IP_MAX_TRACKED; i++) {
        expect(tryAcquireInvalidApiKeyIpSlot(`ip-${i}`, now)).toBe(true);
      }
      expect(trackedInvalidApiKeyIpCountForTest()).toBe(INVALID_API_KEY_IP_MAX_TRACKED);

      // A brand-new IP at the cap gets no bucket. Denying is the only safe
      // answer: handing it `true` would make "we ran out of memory" read as
      // "you are allowed", which is precisely the bypass the cap exists to
      // prevent. An IP already tracked is unaffected.
      expect(tryAcquireInvalidApiKeyIpSlot("9.9.9.9", now)).toBe(false);
      expect(tryAcquireInvalidApiKeyIpSlot("ip-0", now)).toBe(true);
    });
  });

  describe("claimInvalidApiKeyRateLimitAuditSlot", () => {
    it("grants the first write and returns zero suppressed", () => {
      expect(claimInvalidApiKeyRateLimitAuditSlot(1_000_000)).toEqual({
        write: true,
        suppressed: 0,
      });
    });

    it("suppresses further claims within the same window and counts them", () => {
      const now = 1_000_000;
      claimInvalidApiKeyRateLimitAuditSlot(now);

      expect(claimInvalidApiKeyRateLimitAuditSlot(now + 1)).toEqual({
        write: false,
        suppressed: 1,
      });
    });

    it("is GLOBAL, not keyed by IP — a second address inside the open window is suppressed", () => {
      // AGENTS.md § "`/api/internal/` Is A Security Claim, Not A Folder Name":
      // the remote address is caller-supplied, so a window keyed on it grows
      // per request and the throttle stops throttling. Keying this one would
      // hand an unauthenticated caller one audit row per source address.
      const now = 1_000_000;
      claimInvalidApiKeyRateLimitAuditSlot(now);

      expect(claimInvalidApiKeyRateLimitAuditSlot(now + 1)).toEqual({
        write: false,
        suppressed: 1,
      });
      expect(claimInvalidApiKeyRateLimitAuditSlot(now + 2)).toEqual({
        write: false,
        suppressed: 2,
      });
    });

    it("opens a new window and reports the prior suppressed count once it elapses", () => {
      const start = 1_000_000;
      claimInvalidApiKeyRateLimitAuditSlot(start);
      claimInvalidApiKeyRateLimitAuditSlot(start + 1);
      claimInvalidApiKeyRateLimitAuditSlot(start + 2);

      expect(
        claimInvalidApiKeyRateLimitAuditSlot(start + INVALID_API_KEY_RATE_LIMIT_WINDOW_MS + 1)
      ).toEqual({ write: true, suppressed: 2 });
    });
  });
});
