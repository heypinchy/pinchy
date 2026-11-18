import { describe, it, expect } from "vitest";
import { senderNameSchema } from "@/lib/schemas/sender-name";
import { imapCreateSchema } from "@/lib/schemas/imap";
import { imapEditSchema } from "@/lib/schemas/integration-edit";

/**
 * The From-header display-name guard, single-sourced in the #1087 sweep from
 * two byte-identical copies (create and edit) — and left without a test of its
 * own, which is the wrong half to leave untested: this `.refine` is a header
 * injection barrier, and a schema that silently loses it still looks validated
 * at every call site.
 *
 * The last two cases assert the *composition* rather than the rule again: both
 * schemas must keep applying it, because "shared" is a claim about the import,
 * not about the field.
 */
describe("senderNameSchema", () => {
  it("accepts an ordinary display name", () => {
    expect(senderNameSchema.safeParse("Support Team").success).toBe(true);
  });

  it("rejects a CR/LF header-injection attempt with a message that names the reason", () => {
    const parsed = senderNameSchema.safeParse("Support\r\nBcc: evil@example.com");
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe("Sender name must not contain line breaks");
    }
  });

  it("rejects a bare LF as well as a full CRLF", () => {
    expect(senderNameSchema.safeParse("Support\nBcc: evil@example.com").success).toBe(false);
    expect(senderNameSchema.safeParse("Support\rBcc: evil@example.com").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(senderNameSchema.safeParse("").success).toBe(false);
  });

  it("accepts exactly 200 characters and rejects 201", () => {
    expect(senderNameSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(senderNameSchema.safeParse("a".repeat(201)).success).toBe(false);
  });

  it("still guards the create schema's senderName field", () => {
    const parsed = imapCreateSchema.safeParse({
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "user@example.com",
      password: "secret",
      security: "tls",
      senderName: "Bad\r\nBcc: evil@example.com",
    });
    expect(parsed.success).toBe(false);
  });

  it("still guards the edit schema's senderName field", () => {
    expect(imapEditSchema.safeParse({ senderName: "Bad\r\nBcc: evil@example.com" }).success).toBe(
      false
    );
    expect(imapEditSchema.safeParse({ senderName: "Support Team" }).success).toBe(true);
  });
});
