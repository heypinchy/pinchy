import { describe, it, expect, vi, beforeEach } from "vitest";

const verify = vi.fn();
const sendMail = vi.fn();
const close = vi.fn();
const createTransport = vi.fn(() => ({ verify, sendMail, close }));

vi.mock("nodemailer", () => ({ default: { createTransport } }));

vi.mock("@/lib/integrations/mail-host-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/mail-host-guard")>();
  return {
    ...actual,
    resolveAllowedMailHost: vi.fn().mockResolvedValue({ address: "203.0.113.7", family: 4 }),
  };
});

import {
  transportOptions,
  verifySystemMail,
  sendSystemMail,
  formatFrom,
} from "@/lib/system-mail/transport";
import { resolveAllowedMailHost, MailHostBlockedError } from "@/lib/integrations/mail-host-guard";

const config = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls" as const,
  username: "pinchy@example.com",
  password: "s3cret",
  fromAddress: "pinchy@example.com",
};

describe("transportOptions", () => {
  it("STARTTLS requires the upgrade rather than allowing a silent plaintext fallback", () => {
    expect(transportOptions(config)).toMatchObject({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  it("TLS connects encrypted from the first byte", () => {
    expect(transportOptions({ ...config, port: 465, security: "tls" })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });

  it("none sends without encryption", () => {
    expect(transportOptions({ ...config, port: 25, security: "none" })).toMatchObject({
      secure: false,
      requireTLS: false,
    });
  });

  it("authenticates only when a username is set", () => {
    expect(transportOptions(config).auth).toEqual({ user: "pinchy@example.com", pass: "s3cret" });
    expect(transportOptions({ ...config, username: undefined }).auth).toBeUndefined();
  });

  it("bounds every phase so a dead server can't hold a request for minutes", () => {
    expect(transportOptions(config)).toMatchObject({
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  });
});

describe("formatFrom", () => {
  it("defaults the display name to Pinchy", () => {
    expect(formatFrom(config)).toEqual({ name: "Pinchy", address: "pinchy@example.com" });
  });

  it("uses the configured display name", () => {
    expect(formatFrom({ ...config, fromName: "Acme IT" })).toEqual({
      name: "Acme IT",
      address: "pinchy@example.com",
    });
  });
});

describe("verifySystemMail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("checks the host against the SSRF guard before connecting", async () => {
    vi.mocked(resolveAllowedMailHost).mockRejectedValueOnce(new MailHostBlockedError("Blocked"));
    await expect(verifySystemMail(config)).rejects.toThrow("Blocked");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("connects to the checked IP and keeps the hostname for TLS (no second resolve)", async () => {
    verify.mockResolvedValueOnce(true);
    await verifySystemMail(config);
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "203.0.113.7", tls: { servername: "smtp.example.com" } })
    );
  });

  it("does not connect when the host does not resolve", async () => {
    vi.mocked(resolveAllowedMailHost).mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
    );
    await expect(verifySystemMail(config)).rejects.toThrow("ENOTFOUND");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("verifies and closes the connection", async () => {
    verify.mockResolvedValueOnce(true);
    await verifySystemMail(config);
    expect(verify).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("closes the connection when verify fails", async () => {
    verify.mockRejectedValueOnce(new Error("535 auth failed"));
    await expect(verifySystemMail(config)).rejects.toThrow("535");
    expect(close).toHaveBeenCalled();
  });
});

describe("sendSystemMail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the message from the configured sender", async () => {
    sendMail.mockResolvedValueOnce({ messageId: "m1" });
    await sendSystemMail(config, {
      to: "anna@example.com",
      subject: "Hi",
      text: "t",
      html: "<p>t</p>",
    });
    expect(resolveAllowedMailHost).toHaveBeenCalledWith("smtp.example.com");
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: "Pinchy", address: "pinchy@example.com" },
      to: "anna@example.com",
      subject: "Hi",
      text: "t",
      html: "<p>t</p>",
    });
    expect(close).toHaveBeenCalled();
  });
});
