import { describe, it, expect } from "vitest";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";

describe("maskConnectionCredentials", () => {
  describe("imap", () => {
    const imapCredentials = {
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "mailbox@example.com",
      password: "super-secret-app-password",
      security: "tls" as const,
    };

    function fakeDecrypt(ciphertext: string): string {
      return ciphertext;
    }

    it("returns non-secret identifying fields and never the password", () => {
      const encrypted = JSON.stringify(imapCredentials);

      const masked = maskConnectionCredentials("imap", encrypted, fakeDecrypt);

      expect(masked.imapHost).toBe("imap.example.com");
      expect(masked.username).toBe("mailbox@example.com");
      expect(masked).not.toHaveProperty("password");

      const serialized = JSON.stringify(masked);
      expect(serialized).not.toContain(imapCredentials.password);
    });

    it("does not return odoo-style undefined url/db/login fields", () => {
      const encrypted = JSON.stringify(imapCredentials);

      const masked = maskConnectionCredentials("imap", encrypted, fakeDecrypt);

      // Regression guard for the bug: imap used to fall through to the
      // odoo-style masker, which picks `url`/`db`/`login` by name and
      // silently returns `undefined` for all three on an imap blob.
      expect(masked.url).toBeUndefined();
      expect(masked.db).toBeUndefined();
      expect(masked.login).toBeUndefined();
    });

    it("returns senderName when present in the blob (not a secret, needed for edit-dialog prefill)", () => {
      const encrypted = JSON.stringify({ ...imapCredentials, senderName: "Support Team" });

      const masked = maskConnectionCredentials("imap", encrypted, fakeDecrypt);

      expect(masked.senderName).toBe("Support Team");
    });

    it("returns an empty string for senderName when absent from the blob", () => {
      const encrypted = JSON.stringify(imapCredentials);

      const masked = maskConnectionCredentials("imap", encrypted, fakeDecrypt);

      expect(masked.senderName).toBe("");
    });

    it("still never returns the password even when senderName is present", () => {
      const encrypted = JSON.stringify({ ...imapCredentials, senderName: "Support Team" });

      const masked = maskConnectionCredentials("imap", encrypted, fakeDecrypt);

      expect(masked).not.toHaveProperty("password");
      expect(JSON.stringify(masked)).not.toContain(imapCredentials.password);
    });
  });
});
