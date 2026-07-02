import { describe, it, expect } from "vitest";
import {
  isCannotDecrypt,
  needsAttention,
  countIntegrationHealth,
} from "@/lib/integrations/connection-health";

// decrypt throws for credentials starting with "BAD" (wrong ENCRYPTION_KEY).
function fakeDecrypt(ciphertext: string): string {
  if (ciphertext.startsWith("BAD")) throw new Error("bad key");
  return JSON.stringify({ url: "u", db: "d", login: "l" });
}

function row(o: Partial<{ type: string; credentials: string; status: string }> = {}) {
  return { type: "odoo", credentials: "OK", status: "active", ...o };
}

describe("connection-health", () => {
  describe("isCannotDecrypt", () => {
    it("is false when credentials decrypt", () => {
      expect(isCannotDecrypt(row(), fakeDecrypt)).toBe(false);
    });

    it("is true when decrypt throws", () => {
      expect(isCannotDecrypt(row({ credentials: "BAD" }), fakeDecrypt)).toBe(true);
    });

    it("is false for web-search which never decrypts", () => {
      // web-search masking returns { configured: true } without decrypting, so a
      // BAD ciphertext is not flagged unreadable — mirrors GET /api/integrations.
      expect(isCannotDecrypt(row({ type: "web-search", credentials: "BAD" }), fakeDecrypt)).toBe(
        false
      );
    });
  });

  describe("needsAttention", () => {
    it("is true for auth_failed", () => {
      expect(needsAttention(row({ status: "auth_failed" }), fakeDecrypt)).toBe(true);
    });

    it("is true for cannotDecrypt", () => {
      expect(needsAttention(row({ credentials: "BAD" }), fakeDecrypt)).toBe(true);
    });

    it("is false for a healthy active connection", () => {
      expect(needsAttention(row(), fakeDecrypt)).toBe(false);
    });
  });

  describe("countIntegrationHealth", () => {
    it("counts auth_failed and cannotDecrypt separately and their union", () => {
      const counts = countIntegrationHealth(
        [
          row(),
          row({ status: "auth_failed" }),
          row({ credentials: "BAD" }),
          row({ status: "auth_failed", credentials: "BAD" }),
        ],
        fakeDecrypt
      );
      expect(counts.authFailedCount).toBe(2);
      expect(counts.cannotDecryptCount).toBe(2);
      // The doubly-broken row counts once in the union: 3 distinct rows.
      expect(counts.needsAttentionCount).toBe(3);
    });

    it("returns zeros for an empty list", () => {
      expect(countIntegrationHealth([], fakeDecrypt)).toEqual({
        authFailedCount: 0,
        cannotDecryptCount: 0,
        needsAttentionCount: 0,
      });
    });
  });
});
