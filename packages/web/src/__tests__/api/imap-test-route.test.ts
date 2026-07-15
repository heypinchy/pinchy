import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

vi.mock("@/lib/encryption", () => ({
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32, 1)),
}));

const mockAppendAuditLog = vi.fn();
vi.mock("@/lib/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/audit")>("@/lib/audit");
  return {
    ...actual,
    appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  };
});

const mockRecordAuditFailure = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: (...args: unknown[]) => mockRecordAuditFailure(...args),
}));

// Shared mock ImapFlow client, created inside vi.hoisted() so it is visible
// to the vi.mock("imapflow", ...) factory below (vitest hoists vi.mock calls
// above these consts/imports).
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

import { NextRequest } from "next/server";
import { routeContext } from "@/test-helpers/route";

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };
const nonAdminSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const validBody = {
  imapHost: "imap.example.com",
  imapPort: 993,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  username: "mailbox@example.com",
  password: "super-secret-app-password",
  security: "tls" as const,
};

function makeRequest(body?: unknown) {
  return new NextRequest("http://localhost:7777/api/integrations/imap/test", {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/integrations/imap/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImapClient.connect.mockResolvedValue(undefined);
    mockImapClient.logout.mockResolvedValue(undefined);
    mockTransport.verify.mockResolvedValue(true);
    mockAppendAuditLog.mockResolvedValue(undefined);
  });

  it("returns 401 when there is no session, without attempting any probe", async () => {
    mockGetSession.mockResolvedValue(null);

    const { POST } = await import("@/app/api/integrations/imap/test/route");
    const response = await POST(makeRequest(validBody), routeContext());

    expect(response.status).toBe(401);
    expect(ImapFlowMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin session, without attempting any probe", async () => {
    mockGetSession.mockResolvedValue(nonAdminSession);

    const { POST } = await import("@/app/api/integrations/imap/test/route");
    const response = await POST(makeRequest(validBody), routeContext());

    expect(response.status).toBe(403);
    expect(ImapFlowMock).not.toHaveBeenCalled();
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  describe("as admin", () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue(adminSession);
    });

    it("returns 400 with structured validation details for an invalid body (missing imapHost, bad port, bad security)", async () => {
      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(
        makeRequest({
          imapPort: 999999,
          smtpHost: "smtp.example.com",
          smtpPort: 587,
          username: "mailbox@example.com",
          password: "pw",
          security: "carrier-pigeon",
        }),
        routeContext()
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe("Validation failed");
      expect(body.details).toBeDefined();
      expect(ImapFlowMock).not.toHaveBeenCalled();
      expect(createTransportMock).not.toHaveBeenCalled();
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("returns 200 { ok: true } and writes a success audit entry when both probes succeed", async () => {
      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest(validBody), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });

      expect(mockImapClient.connect).toHaveBeenCalled();
      expect(mockImapClient.logout).toHaveBeenCalled();
      expect(mockTransport.verify).toHaveBeenCalled();

      // The probe must bound its timeouts so a firewalled/dead host cannot hang
      // the user-facing request for the libraries' long defaults (~90s / ~2min).
      expect(ImapFlowMock).toHaveBeenCalledWith(
        expect.objectContaining({ connectionTimeout: expect.any(Number) })
      );
      expect(createTransportMock).toHaveBeenCalledWith(
        expect.objectContaining({ connectionTimeout: expect.any(Number) })
      );

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.eventType).toBe("integration.credentials_tested");
      expect(entry.outcome).toBe("success");
      expect(entry.detail.imapHost).toBe("imap.example.com");
      expect(entry.detail.smtpHost).toBe("smtp.example.com");

      const serializedEntry = JSON.stringify(entry);
      expect(serializedEntry).not.toContain(validBody.password);
    });

    it("returns 400 { ok: false, error } and writes a failure audit entry when the IMAP login fails", async () => {
      mockImapClient.connect.mockRejectedValue(
        new Error("Authentication failed for user mailbox@example.com")
      );

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest(validBody), routeContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error.toLowerCase()).toContain("authentication");

      // SMTP should not even be attempted once IMAP has already failed the test.
      expect(createTransportMock).not.toHaveBeenCalled();

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.eventType).toBe("integration.credentials_tested");
      expect(entry.outcome).toBe("failure");

      const serializedEntry = JSON.stringify(entry);
      expect(serializedEntry).not.toContain(validBody.password);
      expect(serializedEntry).not.toMatch(/at\s+Object/); // no raw stack trace
    });

    it("returns 400 { ok: false, error } and writes a failure audit entry when the SMTP verify fails", async () => {
      mockTransport.verify.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:587"));

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest(validBody), routeContext());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");

      expect(mockImapClient.connect).toHaveBeenCalled();
      expect(mockImapClient.logout).toHaveBeenCalled();

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.eventType).toBe("integration.credentials_tested");
      expect(entry.outcome).toBe("failure");

      const serializedEntry = JSON.stringify(entry);
      expect(serializedEntry).not.toContain(validBody.password);
    });

    it("never includes the plaintext password in the audit detail across success and failure paths", async () => {
      const { POST } = await import("@/app/api/integrations/imap/test/route");

      await POST(makeRequest(validBody), routeContext());
      mockImapClient.connect.mockRejectedValueOnce(new Error("bad credentials"));
      await POST(makeRequest(validBody), routeContext());

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(2);
      for (const call of mockAppendAuditLog.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain(validBody.password);
      }
    });
  });
});
