import { describe, it, expect } from "vitest";
import { imapEditSchema, mcpEditSchema } from "@/lib/schemas/integration-edit";

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
});

// mcpEditSchema is the single source of truth for the MCP edit-credentials
// contract (token rotation only). extraHeaders (e.g. HighLevel's locationId)
// lives on connection.data and is reused during re-discovery, so the edit
// form intentionally does not carry it.
describe("mcpEditSchema", () => {
  it("accepts a rotated token", () => {
    const parsed = mcpEditSchema.safeParse({ token: "pat-fresh-token" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.token).toBe("pat-fresh-token");
  });

  it("accepts an empty body (no rotation requested)", () => {
    expect(mcpEditSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an empty-string token (no blanking a secret to empty)", () => {
    expect(mcpEditSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("rejects unknown keys (strict) so extraHeaders can't sneak in through the edit form", () => {
    const parsed = mcpEditSchema.safeParse({ token: "x", extraHeaders: { locationId: "loc_1" } });
    expect(parsed.success).toBe(false);
  });
});
