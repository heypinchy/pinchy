import { describe, expect, it } from "vitest";
import { redactEmailToolParamsForAudit } from "@/lib/audit-tool-params";

describe("redactEmailToolParamsForAudit", () => {
  it("reduces the email_send body to a byte-count marker and scrubs the recipient", () => {
    const out = redactEmailToolParamsForAudit("email_send", {
      to: "recipient@test.com",
      subject: "Hello",
      body: "secret body text",
    }) as Record<string, unknown>;

    expect(out.to).toBe("<email-redacted>");
    expect(out.subject).toBe("Hello");
    expect(out.body).toBe(`<redacted ${Buffer.byteLength("secret body text", "utf8")} bytes>`);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("recipient@test.com");
    expect(serialized).not.toContain("secret body text");
  });

  it("scrubs an address embedded in a free-text subject", () => {
    const out = redactEmailToolParamsForAudit("email_draft", {
      to: "a@b.com",
      subject: "Re: your mail to max@firma.de",
      body: "hi",
    }) as Record<string, unknown>;

    expect(out.subject).toBe("Re: your mail to <email-redacted>");
    expect(JSON.stringify(out)).not.toContain("max@firma.de");
  });

  it("scrubs email_search address filters and free-text terms while keeping structured filters", () => {
    const out = redactEmailToolParamsForAudit("email_search", {
      from: "sender@test.com",
      to: "recipient@test.com",
      text: "invoice from max@firma.de",
      folder: "INBOX",
      unread: true,
      limit: 5,
    }) as Record<string, unknown>;

    expect(out.from).toBe("<email-redacted>");
    expect(out.to).toBe("<email-redacted>");
    expect(out.text).toBe("invoice from <email-redacted>");
    // Structured, non-PII filters stay verbatim for forensic value.
    expect(out.folder).toBe("INBOX");
    expect(out.unread).toBe(true);
    expect(out.limit).toBe(5);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("sender@test.com");
    expect(serialized).not.toContain("recipient@test.com");
    expect(serialized).not.toContain("max@firma.de");
  });

  it("leaves params of non-email tools untouched (scoped by tool name)", () => {
    const params = { path: "/data/x.md", note: "reach me at a@b.com" };
    const out = redactEmailToolParamsForAudit("pinchy_read", params);
    expect(out).toBe(params);
  });

  it("preserves the params reference when there is nothing to redact", () => {
    const params = { folder: "INBOX", unread: true };
    const out = redactEmailToolParamsForAudit("email_search", params) as Record<string, unknown>;
    // A shallow copy is returned; values are unchanged.
    expect(out).toEqual(params);
  });

  it("returns non-object params unchanged", () => {
    expect(redactEmailToolParamsForAudit("email_send", undefined)).toBeUndefined();
    expect(redactEmailToolParamsForAudit("email_send", "raw")).toBe("raw");
    const arr = ["a@b.com"];
    expect(redactEmailToolParamsForAudit("email_send", arr)).toBe(arr);
  });

  it("does not mutate the input object", () => {
    const params = { to: "recipient@test.com", body: "secret" };
    redactEmailToolParamsForAudit("email_send", params);
    expect(params.to).toBe("recipient@test.com");
    expect(params.body).toBe("secret");
  });
});
