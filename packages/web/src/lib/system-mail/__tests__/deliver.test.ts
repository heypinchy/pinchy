import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/system-mail/config", () => ({ getSystemMailConfig: vi.fn() }));
vi.mock("@/lib/system-mail/transport", () => ({ sendSystemMail: vi.fn() }));
vi.mock("@/lib/domain", () => ({ getDomain: vi.fn(async () => null) }));
vi.mock("@/lib/settings-timezone", () => ({ getOrgTimezone: vi.fn(async () => "UTC") }));
vi.mock("@/lib/audit-deferred", () => ({ deferAuditLog: vi.fn() }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    redactEmail: (email: string) => ({ emailHash: `hash-${email.length}`, emailPreview: "a***@x" }),
  };
});

import { getSystemMailConfig } from "@/lib/system-mail/config";
import { sendSystemMail } from "@/lib/system-mail/transport";
import { deferAuditLog } from "@/lib/audit-deferred";
import { deliverLinkEmail, deliverTestEmail } from "@/lib/system-mail/deliver";
import { classifyMailError } from "@/lib/system-mail/errors";

const config = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls" as const,
  username: "u",
  password: "p",
  fromAddress: "pinchy@example.com",
};

const request = new Request("http://localhost/api/users/invite", {
  method: "POST",
  headers: { "x-forwarded-proto": "https", "x-forwarded-host": "pinchy.acme.io" },
});

const input = {
  request,
  kind: "invite" as const,
  to: "anna@example.com",
  token: "tok123",
  expiresAt: new Date("2026-11-12T10:00:00Z"),
  inviteId: "inv-1",
  actor: { id: "admin-1", name: "Clemens", email: "clemens@example.com" },
};

describe("deliverLinkEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSystemMailConfig).mockResolvedValue(config);
  });

  it("emails the invite link built from the admin's origin", async () => {
    vi.mocked(sendSystemMail).mockResolvedValue(undefined);
    const result = await deliverLinkEmail(input);
    expect(result).toEqual({ sent: true });
    const [, message] = vi.mocked(sendSystemMail).mock.calls[0];
    expect(message.to).toBe("anna@example.com");
    expect(message.text).toContain("https://pinchy.acme.io/invite/tok123");
    expect(message.text).toContain("pinchy.acme.io");
    expect(message.subject).toBe("Clemens invited you to Pinchy");
  });

  it("writes a mail.sent success row with the recipient redacted", async () => {
    vi.mocked(sendSystemMail).mockResolvedValue(undefined);
    await deliverLinkEmail(input);
    expect(deferAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "mail.sent",
      detail: {
        purpose: "invite",
        emailHash: "hash-16",
        emailPreview: "a***@x",
        invite: { id: "inv-1" },
      },
      outcome: "success",
    });
    const entry = vi.mocked(deferAuditLog).mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toContain("anna@example.com");
    expect(JSON.stringify(entry)).not.toContain("tok123");
  });

  it("never throws: a failed send comes back as an error the dialog can show", async () => {
    vi.mocked(sendSystemMail).mockRejectedValue(new Error("Invalid login: 535 auth failed"));
    const result = await deliverLinkEmail(input);
    expect(result).toEqual({
      sent: false,
      error: "Authentication failed — check the username and password",
    });
    expect(deferAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "mail.sent",
        outcome: "failure",
        error: { message: "Authentication failed — check the username and password" },
      })
    );
  });

  it("logs the classified error, never the raw SMTP message that carries the recipient", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendSystemMail).mockRejectedValue(
      Object.assign(
        new Error("Can't send mail - all recipients were rejected: <anna@example.com>"),
        {
          command: "RCPT TO",
          code: "EENVELOPE",
          responseCode: 550,
        }
      )
    );
    await deliverLinkEmail(input);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("anna@example.com");
    expect(logged).toContain("The mail server refused the recipient address.");
    // The non-PII diagnostics survive: they are what an operator greps for.
    expect(logged).toContain("EENVELOPE");
    expect(logged).toContain("RCPT TO");
    expect(logged).toContain("550");
    spy.mockRestore();
  });

  it("reports a missing mailer instead of pretending to send", async () => {
    vi.mocked(getSystemMailConfig).mockResolvedValue(null);
    const result = await deliverLinkEmail(input);
    expect(result).toEqual({ sent: false, error: "Email delivery isn't set up." });
    expect(sendSystemMail).not.toHaveBeenCalled();
  });

  it("labels a reset as password_reset in the audit row", async () => {
    vi.mocked(sendSystemMail).mockResolvedValue(undefined);
    await deliverLinkEmail({ ...input, kind: "reset" });
    expect(vi.mocked(deferAuditLog).mock.calls[0][0]).toMatchObject({
      detail: { purpose: "password_reset" },
    });
    expect(vi.mocked(sendSystemMail).mock.calls[0][1].subject).toBe("Reset your Pinchy password");
  });
});

describe("deliverTestEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends to the given address with the saved config and audits it", async () => {
    vi.mocked(sendSystemMail).mockResolvedValue(undefined);
    const result = await deliverTestEmail({
      config,
      request,
      to: "clemens@example.com",
      actorId: "admin-1",
    });
    expect(result).toEqual({ sent: true });
    expect(vi.mocked(sendSystemMail).mock.calls[0][1].to).toBe("clemens@example.com");
    expect(vi.mocked(deferAuditLog).mock.calls[0][0]).toMatchObject({
      eventType: "mail.sent",
      detail: { purpose: "test" },
      outcome: "success",
    });
  });
});

describe("classifyMailError", () => {
  it("names a refused sender address without repeating it — the message lands in the audit row", () => {
    const err = Object.assign(new Error("553 5.7.1 Sender address rejected"), {
      command: "MAIL FROM",
      responseCode: 553,
    });
    const message = classifyMailError(err);
    expect(message).toBe(
      "The mail server refused the sender address — check that this account may send as it."
    );
    expect(message).not.toContain("@");
  });

  it("tells an admin who left out the login that the server wants one", () => {
    const err = Object.assign(new Error("530 5.7.57 Client not authenticated"), {
      command: "MAIL FROM",
      responseCode: 530,
    });
    expect(classifyMailError(err)).toBe(
      "The mail server wants a login before it sends — add a username and password."
    );
  });

  it("names a refused recipient", () => {
    const err = Object.assign(new Error("550 No such user"), {
      command: "RCPT TO",
      responseCode: 550,
    });
    expect(classifyMailError(err)).toBe("The mail server refused the recipient address.");
  });

  it("names a server that doesn't offer the required STARTTLS", () => {
    const err = Object.assign(new Error("Error upgrading connection with STARTTLS"), {
      code: "ETLS",
    });
    expect(classifyMailError(err)).toBe(
      "Could not establish a secure connection — check the encryption setting"
    );
  });

  it("falls back to the shared connection diagnosis", () => {
    expect(classifyMailError(new Error("connect ECONNREFUSED"))).toBe(
      "Connection refused — check the host and port"
    );
  });
});
