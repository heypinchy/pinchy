import { describe, it, expect } from "vitest";
import { senderNameSchema } from "@/lib/schemas/sender-name";
import { imapCreateSchema } from "@/lib/schemas/imap";
import { imapEditSchema } from "@/lib/schemas/integration-edit";

// senderNameSchema is the single source of truth for the From-header
// display-name guard, shared by imapCreateSchema and imapEditSchema (issue
// #1087 dedup sweep — the two previously carried byte-identical copies).
describe("senderNameSchema", () => {
  it("accepts an ordinary display name", () => {
    expect(senderNameSchema.safeParse("Support Team").success).toBe(true);
  });

  it("rejects a CR/LF header-injection attempt", () => {
    const parsed = senderNameSchema.safeParse("Support\r\nBcc: evil@example.com");
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe("Sender name must not contain line breaks");
    }
  });

  it("rejects an empty string", () => {
    expect(senderNameSchema.safeParse("").success).toBe(false);
  });

  it("rejects a string over 200 characters", () => {
    expect(senderNameSchema.safeParse("a".repeat(201)).success).toBe(false);
  });

  it("accepts exactly 200 characters", () => {
    expect(senderNameSchema.safeParse("a".repeat(200)).success).toBe(true);
  });

  it("is reused verbatim by imapCreateSchema (optional, same rejection)", () => {
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

  it("is reused verbatim by imapEditSchema (optional, same rejection)", () => {
    const parsed = imapEditSchema.safeParse({ senderName: "Bad\r\nBcc: evil@example.com" });
    expect(parsed.success).toBe(false);
  });
});
