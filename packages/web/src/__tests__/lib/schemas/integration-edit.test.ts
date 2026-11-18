import { describe, it, expect } from "vitest";
import { imapEditSchema } from "@/lib/schemas/integration-edit";
import { imapTestSchema } from "@/lib/schemas/imap";

// imapEditSchema is the single source of truth for the IMAP edit-credentials
// contract, imported by BOTH the client dialog (edit-credentials-dialog.tsx)
// and the PATCH route ([connectionId]/route.ts). These tests pin the guards
// the server must enforce so the two sides can't drift.
describe("imapEditSchema", () => {
  it("accepts a valid partial and coerces string ports to numbers", () => {
    const parsed = imapEditSchema.safeParse({ imapHost: "imap.example.com", imapPort: "993" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.imapPort).toBe(993);
  });

  it("rejects a senderName containing CR/LF (header-injection guard)", () => {
    const parsed = imapEditSchema.safeParse({ senderName: "Support\r\nBcc: evil@example.com" });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty host/username strings (no blanking a field to empty)", () => {
    expect(imapEditSchema.safeParse({ imapHost: "" }).success).toBe(false);
    expect(imapEditSchema.safeParse({ username: "" }).success).toBe(false);
  });

  it("rejects unknown keys (strict) so a typo can't silently pass through", () => {
    const parsed = imapEditSchema.safeParse({ imapHost: "imap.example.com", bogus: "x" });
    expect(parsed.success).toBe(false);
  });

  it("rejects out-of-range ports", () => {
    expect(imapEditSchema.safeParse({ imapPort: "999999" }).success).toBe(false);
  });

  // A DNS name is at most 253 characters. Anything longer is not a host, and
  // it would land verbatim in the destination diff of an audit row.
  it("rejects a host name longer than 253 characters, with a message on that field", () => {
    const long = `${"a".repeat(250)}.example.com`;
    for (const field of ["imapHost", "smtpHost"] as const) {
      const parsed = imapEditSchema.safeParse({ [field]: long });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.flatten().fieldErrors[field]).toEqual([
          "The host name is too long — 253 characters at most.",
        ]);
      }
    }
    expect(imapEditSchema.safeParse({ imapHost: "a".repeat(253) }).success).toBe(true);
  });
});

describe("imapTestSchema", () => {
  it("rejects a host name longer than 253 characters", () => {
    const base = {
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "team",
      password: "pw",
      security: "tls",
    };
    expect(imapTestSchema.safeParse(base).success).toBe(true);
    expect(imapTestSchema.safeParse({ ...base, imapHost: "a".repeat(254) }).success).toBe(false);
    expect(imapTestSchema.safeParse({ ...base, smtpHost: "a".repeat(254) }).success).toBe(false);
  });
});
