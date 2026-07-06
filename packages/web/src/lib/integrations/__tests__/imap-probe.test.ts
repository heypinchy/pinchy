import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock ImapFlow client, created inside vi.hoisted() so it is visible
// to the vi.mock("imapflow", ...) factory below (vitest hoists vi.mock calls
// above these consts/imports). Mirrors the mocking pattern used in
// imap-test-route.test.ts.
const { mockImapClient, ImapFlowMock } = vi.hoisted(() => {
  const mockImapClient = {
    connect: vi.fn(),
    logout: vi.fn(),
  };
  const ImapFlowMock = vi.fn().mockImplementation(function ImapFlow() {
    return mockImapClient;
  });
  return { mockImapClient, ImapFlowMock };
});

vi.mock("imapflow", () => ({
  ImapFlow: ImapFlowMock,
}));

const { mockTransport, createTransportMock } = vi.hoisted(() => {
  const mockTransport = {
    verify: vi.fn(),
    close: vi.fn(),
  };
  const createTransportMock = vi.fn().mockReturnValue(mockTransport);
  return { mockTransport, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

import { testImapLogin, testSmtpVerify, friendlyError } from "@/lib/integrations/imap-probe";

const input = {
  imapHost: "imap.example.com",
  imapPort: 993,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  username: "mailbox@example.com",
  password: "super-secret-app-password",
  security: "tls" as const,
};

describe("imap-probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImapClient.connect.mockResolvedValue(undefined);
    mockImapClient.logout.mockResolvedValue(undefined);
    mockTransport.verify.mockResolvedValue(true);
  });

  describe("testImapLogin", () => {
    it("connects and logs out with bounded timeouts", async () => {
      await testImapLogin(input);

      expect(ImapFlowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          host: input.imapHost,
          port: input.imapPort,
          secure: true,
          auth: { user: input.username, pass: input.password },
          connectionTimeout: expect.any(Number),
          greetingTimeout: expect.any(Number),
          socketTimeout: expect.any(Number),
        })
      );
      expect(mockImapClient.connect).toHaveBeenCalled();
      expect(mockImapClient.logout).toHaveBeenCalled();
    });

    it("propagates a connection failure", async () => {
      mockImapClient.connect.mockRejectedValue(new Error("Authentication failed"));

      await expect(testImapLogin(input)).rejects.toThrow("Authentication failed");
    });
  });

  describe("testSmtpVerify", () => {
    it("verifies and closes the transport with bounded timeouts", async () => {
      await testSmtpVerify(input);

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          host: input.smtpHost,
          port: input.smtpPort,
          secure: true,
          auth: { user: input.username, pass: input.password },
          connectionTimeout: expect.any(Number),
          greetingTimeout: expect.any(Number),
          socketTimeout: expect.any(Number),
        })
      );
      expect(mockTransport.verify).toHaveBeenCalled();
      expect(mockTransport.close).toHaveBeenCalled();
    });

    it("propagates a verify failure and still closes the transport", async () => {
      mockTransport.verify.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:587"));

      await expect(testSmtpVerify(input)).rejects.toThrow("ECONNREFUSED");
      expect(mockTransport.close).toHaveBeenCalled();
    });
  });

  describe("friendlyError", () => {
    it("maps auth-shaped errors to an authentication-failed message", () => {
      expect(friendlyError(new Error("Invalid login credentials"))).toMatch(/authentication/i);
      expect(friendlyError(new Error("535 5.7.8 Authentication failed"))).toMatch(
        /authentication/i
      );
    });

    it("maps timeout errors to a timeout message", () => {
      expect(friendlyError(new Error("Connection timed out"))).toMatch(/timed out/i);
      expect(friendlyError(new Error("ETIMEDOUT"))).toMatch(/timed out/i);
    });

    it("maps connection-refused/unreachable errors to a connect-failure message", () => {
      expect(friendlyError(new Error("connect ECONNREFUSED 127.0.0.1:993"))).toMatch(
        /could not connect/i
      );
      expect(friendlyError(new Error("getaddrinfo ENOTFOUND imap.example.com"))).toMatch(
        /could not connect/i
      );
    });

    it("maps TLS/certificate errors to a secure-connection message", () => {
      expect(friendlyError(new Error("self signed certificate"))).toMatch(/secure connection/i);
    });

    it("falls back to a generic message for unrecognized errors", () => {
      expect(friendlyError(new Error("something weird"))).toMatch(/connection failed/i);
      expect(friendlyError("not an Error instance")).toMatch(/connection failed/i);
    });
  });
});
