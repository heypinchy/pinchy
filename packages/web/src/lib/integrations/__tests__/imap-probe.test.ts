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

// Fake TCP socket for probeSmtpPorts, hoisted so it's visible to the
// vi.mock("node:net", ...) factory below (vitest hoists vi.mock calls above
// these consts/imports). Each call to the mocked `connect()` returns a fresh
// EventEmitter-based fake socket the test drives by hand (emit "connect" /
// "timeout" / "error") instead of racing real sockets or fake timers.
const { mockNetConnect, fakeSockets } = vi.hoisted(() => {
  const fakeSockets: Array<{
    emit: (event: string, ...args: unknown[]) => void;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const mockNetConnect = vi.fn((_options: unknown) => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const socket = {
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(listener);
        listeners.set(event, existing);
        return socket;
      }),
      removeAllListeners: vi.fn(() => {
        listeners.clear();
        return socket;
      }),
      destroy: vi.fn(),
      emit: (event: string, ...args: unknown[]) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    };
    fakeSockets.push(socket);
    return socket;
  });
  return { mockNetConnect, fakeSockets };
});

vi.mock("node:net", () => ({ connect: mockNetConnect, default: { connect: mockNetConnect } }));

import {
  testImapLogin,
  testSmtpVerify,
  friendlyError,
  classifyProbeError,
  probeSmtpPorts,
  tlsModeForPort,
} from "@/lib/integrations/imap-probe";

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

    it("uses implicit TLS (secure:true) for the implicit-TLS IMAP port 993", async () => {
      await testImapLogin({ ...input, imapPort: 993 });

      expect(ImapFlowMock).toHaveBeenCalledWith(
        expect.objectContaining({ port: 993, secure: true })
      );
    });

    it("uses STARTTLS (secure:false) for the STARTTLS IMAP port 143", async () => {
      await testImapLogin({ ...input, imapPort: 143 });

      expect(ImapFlowMock).toHaveBeenCalledWith(
        expect.objectContaining({ port: 143, secure: false })
      );
    });

    it("disables encryption for security 'none'", async () => {
      await testImapLogin({ ...input, security: "none", imapPort: 143 });

      expect(ImapFlowMock).toHaveBeenCalledWith(
        expect.objectContaining({ port: 143, secure: false })
      );
    });

    it("propagates a connection failure", async () => {
      mockImapClient.connect.mockRejectedValue(new Error("Authentication failed"));

      await expect(testImapLogin(input)).rejects.toThrow("Authentication failed");
    });
  });

  describe("tlsModeForPort", () => {
    it("disables all encryption for security 'none' regardless of port", () => {
      expect(tlsModeForPort(993, "none")).toEqual({ secure: false, requireTLS: false });
      expect(tlsModeForPort(587, "none")).toEqual({ secure: false, requireTLS: false });
      expect(tlsModeForPort(465, "none")).toEqual({ secure: false, requireTLS: false });
    });

    it.each([993, 465])(
      "uses implicit TLS (secure:true, requireTLS:false) for implicit-TLS port %i",
      (port) => {
        expect(tlsModeForPort(port, "tls")).toEqual({ secure: true, requireTLS: false });
      }
    );

    it.each([143, 587, 25])(
      "uses STARTTLS (secure:false, requireTLS:true) for non-implicit port %i",
      (port) => {
        expect(tlsModeForPort(port, "tls")).toEqual({ secure: false, requireTLS: true });
        expect(tlsModeForPort(port, "starttls")).toEqual({ secure: false, requireTLS: true });
      }
    );

    it("derives gmail defaults: imap 993 implicit, smtp 587 STARTTLS", () => {
      expect(tlsModeForPort(993, "tls")).toEqual({ secure: true, requireTLS: false });
      expect(tlsModeForPort(587, "tls")).toEqual({ secure: false, requireTLS: true });
    });

    it("derives yahoo smtp 465 as implicit TLS", () => {
      expect(tlsModeForPort(465, "tls")).toEqual({ secure: true, requireTLS: false });
    });
  });

  describe("testSmtpVerify", () => {
    it("verifies and closes the transport with bounded timeouts", async () => {
      await testSmtpVerify(input);

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          host: input.smtpHost,
          port: input.smtpPort,
          // SMTP submission port 587 is STARTTLS, not implicit TLS: TLS mode is
          // keyed off the port, so even with security "tls" this is
          // secure:false + requireTLS:true.
          secure: false,
          requireTLS: true,
          auth: { user: input.username, pass: input.password },
          connectionTimeout: expect.any(Number),
          greetingTimeout: expect.any(Number),
          socketTimeout: expect.any(Number),
        })
      );
      expect(mockTransport.verify).toHaveBeenCalled();
      expect(mockTransport.close).toHaveBeenCalled();
    });

    it("uses implicit TLS (secure:true) for the implicit-TLS SMTP port 465", async () => {
      await testSmtpVerify({ ...input, smtpPort: 465 });

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 465,
          secure: true,
          requireTLS: false,
        })
      );
    });

    it("disables encryption for security 'none'", async () => {
      await testSmtpVerify({ ...input, security: "none", smtpPort: 25 });

      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 25,
          secure: false,
          requireTLS: false,
        })
      );
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

  describe("classifyProbeError", () => {
    it.each([
      ["ETIMEDOUT", new Error("connect ETIMEDOUT 1.2.3.4:465"), "timeout"],
      ["'timed out' wording", new Error("Connection timed out"), "timeout"],
      ["socket timeout", new Error("Socket timeout"), "timeout"],
      ["ECONNREFUSED", new Error("connect ECONNREFUSED 127.0.0.1:465"), "refused"],
      ["ENOTFOUND", new Error("getaddrinfo ENOTFOUND smtp.example.com"), "dns"],
      ["EAI_AGAIN", new Error("getaddrinfo EAI_AGAIN smtp.example.com"), "dns"],
      ["'auth' wording", new Error("Auth failed"), "auth"],
      ["'invalid login' wording", new Error("Invalid login"), "auth"],
      ["535 SMTP auth code", new Error("535 5.7.8 Authentication failed"), "auth"],
      ["certificate error", new Error("unable to verify the first certificate"), "tls"],
      ["self signed certificate", new Error("self signed certificate"), "tls"],
      ["ssl wording", new Error("wrong version number (ssl)"), "tls"],
      ["unmapped error", new Error("something totally unexpected"), "unknown"],
    ] as const)("classifies %s as code %s", (_label, error, expectedCode) => {
      const result = classifyProbeError(error);
      expect(result.code).toBe(expectedCode);
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
    });

    it("notes that cloud hosts often block the port in the timeout message", () => {
      const result = classifyProbeError(new Error("connect ETIMEDOUT 1.2.3.4:465"));
      expect(result.message).toMatch(/cloud host/i);
    });

    it("handles a non-Error value the same way friendlyError does", () => {
      const result = classifyProbeError("not an Error instance");
      expect(result.code).toBe("unknown");
    });
  });

  describe("probeSmtpPorts", () => {
    beforeEach(() => {
      fakeSockets.length = 0;
    });

    it("connects to the default ports (465, 587, 25) in parallel with a 2500ms timeout each", async () => {
      const resultPromise = probeSmtpPorts("smtp.example.com");

      // All three connections must have been initiated synchronously
      // (in parallel), before any of them settle.
      expect(mockNetConnect).toHaveBeenCalledTimes(3);
      expect(mockNetConnect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "smtp.example.com", port: 465, timeout: 2500 })
      );
      expect(mockNetConnect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "smtp.example.com", port: 587, timeout: 2500 })
      );
      expect(mockNetConnect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "smtp.example.com", port: 25, timeout: 2500 })
      );

      fakeSockets[0].emit("error", new Error("ECONNREFUSED")); // 465
      fakeSockets[1].emit("connect"); // 587
      fakeSockets[2].emit("timeout"); // 25

      const results = await resultPromise;

      expect(results).toEqual(
        expect.arrayContaining([
          { port: 465, reachable: false },
          { port: 587, reachable: true },
          { port: 25, reachable: false },
        ])
      );
      for (const socket of fakeSockets) {
        expect(socket.destroy).toHaveBeenCalled();
      }
    });

    it("accepts a custom port list", async () => {
      const resultPromise = probeSmtpPorts("smtp.example.com", [2525]);

      expect(mockNetConnect).toHaveBeenCalledTimes(1);
      fakeSockets[0].emit("connect");

      await expect(resultPromise).resolves.toEqual([{ port: 2525, reachable: true }]);
    });
  });
});
