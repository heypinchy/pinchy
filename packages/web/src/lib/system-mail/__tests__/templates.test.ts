import { describe, it, expect } from "vitest";
import { buildLinkEmail, buildTestEmail } from "@/lib/system-mail/templates";

const base = {
  inviter: { name: "Clemens Helm", email: "clemens@example.com" },
  instanceHost: "pinchy.example.com",
  link: "https://pinchy.example.com/invite/abc123",
  expiresAt: new Date("2026-11-12T10:00:00Z"),
  timeZone: "UTC",
};

describe("buildLinkEmail — invite", () => {
  const email = buildLinkEmail({ ...base, kind: "invite" });

  it("names the inviter in the subject", () => {
    expect(email.subject).toBe("Clemens Helm invited you to Pinchy");
  });

  it("names the inviter, the instance, the link, the expiry and the single use", () => {
    for (const body of [email.text, email.html]) {
      expect(body).toContain("Clemens Helm");
      expect(body).toContain("clemens@example.com");
      expect(body).toContain("pinchy.example.com");
      expect(body).toContain("https://pinchy.example.com/invite/abc123");
      expect(body).toContain("12 November 2026");
      expect(body).toMatch(/works once/);
    }
  });

  it("tells a recipient who wasn't expecting it that they can ignore it", () => {
    expect(email.text).toMatch(/weren't expecting this/);
  });
});

describe("buildLinkEmail — password reset", () => {
  const email = buildLinkEmail({ ...base, kind: "reset" });

  it("says what the link is for", () => {
    expect(email.subject).toBe("Reset your Pinchy password");
    expect(email.text).toContain("password");
    expect(email.text).toContain("https://pinchy.example.com/invite/abc123");
    expect(email.text).toContain("12 November 2026");
  });
});

describe("buildLinkEmail — injection", () => {
  it("strips line breaks from the subject so a display name cannot add headers", () => {
    const email = buildLinkEmail({
      ...base,
      kind: "invite",
      inviter: { name: "Eve\r\nBcc: victim@example.com", email: "eve@example.com" },
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it("escapes every interpolated value in the HTML body", () => {
    const email = buildLinkEmail({
      ...base,
      kind: "invite",
      inviter: { name: '<script>alert("x")</script>', email: "a&b@example.com" },
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("a&amp;b@example.com");
  });

  it("falls back to the inviter's email when they have no name", () => {
    const email = buildLinkEmail({
      ...base,
      kind: "invite",
      inviter: { name: "", email: "clemens@example.com" },
    });
    expect(email.subject).toBe("clemens@example.com invited you to Pinchy");
  });
});

describe("buildLinkEmail — expiry date", () => {
  it("formats the expiry in the organisation's timezone", () => {
    // 23:30 UTC on the 12th is already the 13th in Vienna.
    const email = buildLinkEmail({
      ...base,
      kind: "invite",
      expiresAt: new Date("2026-11-12T23:30:00Z"),
      timeZone: "Europe/Vienna",
    });
    expect(email.text).toContain("13 November 2026");
  });
});

describe("buildTestEmail", () => {
  it("says it is a test and where it came from", () => {
    const email = buildTestEmail({ instanceHost: "pinchy.example.com" });
    expect(email.subject).toBe("Pinchy can send email");
    expect(email.text).toContain("pinchy.example.com");
    expect(email.html).toContain("pinchy.example.com");
  });
});
