import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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

// The SSRF guard resolves both probe hosts before connecting; DNS is stubbed so
// the route tests never depend on real name resolution. The default answer is a
// public address (TEST-NET-3), i.e. "guard allows it" unless a test says
// otherwise.
const { mockDnsLookup } = vi.hoisted(() => ({ mockDnsLookup: vi.fn() }));

vi.mock("node:dns/promises", () => ({
  lookup: mockDnsLookup,
  default: { lookup: mockDnsLookup },
}));

// Only probeSmtpPorts is mocked here (raw TCP reachability probe) — everything
// else in the module (testImapLogin/testSmtpVerify/classifyProbeError) runs
// for real, driven by the imapflow/nodemailer mocks above, so the route's
// leg-classification logic is exercised end to end.
const mockProbeSmtpPorts = vi.fn();
vi.mock("@/lib/integrations/imap-probe", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/integrations/imap-probe")>();
  return {
    ...actual,
    probeSmtpPorts: (...args: Parameters<typeof actual.probeSmtpPorts>) =>
      mockProbeSmtpPorts(...args),
  };
});

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
  // Compile the route's whole dependency graph (better-auth, drizzle, imapflow,
  // nodemailer, …) ONCE here rather than inside whichever test happens to run
  // first. Every test below re-imports the module, but nothing calls
  // vi.resetModules(), so those are cache hits — the first one was paying the
  // transform out of the 5s per-test budget and timing out on a cold cache.
  // The generous hook budget covers that compile on a loaded machine; it bounds
  // setup cost only, never an assertion.
  beforeAll(async () => {
    await import("@/app/api/integrations/imap/test/route");
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockImapClient.connect.mockResolvedValue(undefined);
    mockImapClient.logout.mockResolvedValue(undefined);
    mockTransport.verify.mockResolvedValue(true);
    mockAppendAuditLog.mockResolvedValue(undefined);
    mockDnsLookup.mockResolvedValue([{ address: "203.0.113.50", family: 4 }]);
    mockProbeSmtpPorts.mockReset();
    mockProbeSmtpPorts.mockResolvedValue([
      { port: 465, reachable: false },
      { port: 587, reachable: false },
      { port: 25, reachable: false },
    ]);
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
      expect(body).toEqual({ ok: true, imap: { ok: true }, smtp: { ok: true } });
      // Reachability probe is only run when the SMTP leg actually fails.
      expect(mockProbeSmtpPorts).not.toHaveBeenCalled();

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
      // Whole-shape, not field-by-field: the point is that a success row
      // carries NO failure code (and no stray field the AuditLogEntry union
      // doesn't declare). A per-field assertion cannot see an extra key.
      expect(entry.detail).toEqual({
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        emailHash: expect.any(String),
        emailPreview: expect.any(String),
      });

      const serializedEntry = JSON.stringify(entry);
      expect(serializedEntry).not.toContain(validBody.password);
      // The username is email-shaped, so it must reach the log redacted.
      expect(serializedEntry).not.toContain("mailbox@example.com");
    });

    it("returns 200 { ok: false, imap } and writes a failure audit entry when the IMAP login fails", async () => {
      mockImapClient.connect.mockRejectedValue(
        new Error("Authentication failed for user mailbox@example.com")
      );

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest(validBody), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.imap).toEqual({
        ok: false,
        code: "auth",
        message: expect.stringMatching(/authentication/i),
      });
      expect(typeof body.error).toBe("string");
      expect(body.error.toLowerCase()).toContain("authentication");

      // Both legs run separately now — IMAP failing no longer short-circuits
      // the SMTP probe, since the diagnostic contract always reports both.
      expect(createTransportMock).toHaveBeenCalled();
      expect(body.smtp).toEqual({ ok: true });

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.eventType).toBe("integration.credentials_tested");
      expect(entry.outcome).toBe("failure");
      // Failure codes go into detail, never the raw error/stack trace. Asserted
      // as a whole shape so the row that a reader of AuditLogEntry expects is
      // the row that is actually written: the failing leg's code is present,
      // the passing leg's is absent, and nothing else rides along.
      expect(entry.detail).toEqual({
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        imapCode: "auth",
        emailHash: expect.any(String),
        emailPreview: expect.any(String),
      });

      const serializedEntry = JSON.stringify(entry);
      expect(serializedEntry).not.toContain(validBody.password);
      expect(serializedEntry).not.toMatch(/at\s+Object/); // no raw stack trace
      expect(serializedEntry).not.toContain("mailbox@example.com"); // no raw error text with PII
    });

    it("returns 200 { ok: false, smtp } and writes a failure audit entry when the SMTP verify fails", async () => {
      mockTransport.verify.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:587"));

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest(validBody), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.smtp.ok).toBe(false);
      expect(body.smtp.code).toBe("refused");
      expect(typeof body.error).toBe("string");

      expect(mockImapClient.connect).toHaveBeenCalled();
      expect(mockImapClient.logout).toHaveBeenCalled();

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.eventType).toBe("integration.credentials_tested");
      expect(entry.outcome).toBe("failure");
      // Mirror image of the IMAP case: only the failing leg contributes a code.
      expect(entry.detail).toEqual({
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
        smtpCode: "refused",
        emailHash: expect.any(String),
        emailPreview: expect.any(String),
      });

      const serializedEntry = JSON.stringify(entry);
      expect(serializedEntry).not.toContain(validBody.password);
    });

    it("probes SMTP port reachability and suggests switching to 587 when SMTP times out on 465 and 587 is reachable", async () => {
      mockTransport.verify.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4:465"));
      mockProbeSmtpPorts.mockResolvedValue([
        { port: 465, reachable: false },
        { port: 587, reachable: true },
        { port: 25, reachable: false },
      ]);

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest({ ...validBody, smtpPort: 465 }), routeContext());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.smtp.code).toBe("timeout");
      expect(mockProbeSmtpPorts).toHaveBeenCalledWith("smtp.example.com");
      expect(body.smtpPortProbe).toEqual(expect.arrayContaining([{ port: 587, reachable: true }]));
      expect(body.suggestion).toEqual({
        kind: "switch_smtp_port",
        port: 587,
        security: "starttls",
      });
    });

    it("suggests switching to 465 (implicit TLS) when 587 fails and 465 is reachable", async () => {
      mockTransport.verify.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4:587"));
      mockProbeSmtpPorts.mockResolvedValue([
        { port: 465, reachable: true },
        { port: 587, reachable: false },
        { port: 25, reachable: false },
      ]);

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest({ ...validBody, smtpPort: 587 }), routeContext());
      const body = await response.json();

      expect(body.suggestion).toEqual({ kind: "switch_smtp_port", port: 465, security: "tls" });
    });

    it("suggests switching to 465 when the failing port is 25 and only 465 is reachable", async () => {
      // Regression: previously the 465 suggestion only fired when the failing
      // port was exactly 587, so failing on 25 with 465 reachable (587 blocked)
      // gave no suggestion at all despite a reachable alternative.
      mockTransport.verify.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4:25"));
      mockProbeSmtpPorts.mockResolvedValue([
        { port: 465, reachable: true },
        { port: 587, reachable: false },
        { port: 25, reachable: false },
      ]);

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest({ ...validBody, smtpPort: 25 }), routeContext());
      const body = await response.json();

      expect(body.suggestion).toEqual({ kind: "switch_smtp_port", port: 465, security: "tls" });
    });

    it("reports all_smtp_blocked when neither 465 nor 587 is reachable", async () => {
      mockTransport.verify.mockRejectedValue(new Error("connect ETIMEDOUT 1.2.3.4:465"));
      mockProbeSmtpPorts.mockResolvedValue([
        { port: 465, reachable: false },
        { port: 587, reachable: false },
        { port: 25, reachable: false },
      ]);

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest({ ...validBody, smtpPort: 465 }), routeContext());
      const body = await response.json();

      expect(body.suggestion).toEqual({ kind: "all_smtp_blocked" });
    });

    it("does not probe SMTP port reachability for an auth failure (not a connection-level failure)", async () => {
      mockTransport.verify.mockRejectedValue(new Error("535 Authentication failed"));

      const { POST } = await import("@/app/api/integrations/imap/test/route");
      const response = await POST(makeRequest(validBody), routeContext());
      const body = await response.json();

      expect(body.smtp.code).toBe("auth");
      expect(mockProbeSmtpPorts).not.toHaveBeenCalled();
      expect(body.smtpPortProbe).toBeUndefined();
      expect(body.suggestion).toBeUndefined();
    });

    // The endpoint probes an admin-supplied host:port and reports WHY the
    // connection failed — refused vs. timeout vs. TLS vs. auth. Without a guard
    // that is an internal port scanner with a friendly UI (pinchy#823), so a
    // host pointing inside the network must never reach a socket at all.
    describe("SSRF guard", () => {
      it("blocks both legs, and never opens a socket, when the hosts resolve to loopback", async () => {
        mockDnsLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

        const { POST } = await import("@/app/api/integrations/imap/test/route");
        const response = await POST(makeRequest(validBody), routeContext());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.ok).toBe(false);
        expect(body.imap.code).toBe("blocked");
        expect(body.smtp.code).toBe("blocked");
        expect(ImapFlowMock).not.toHaveBeenCalled();
        expect(createTransportMock).not.toHaveBeenCalled();
      });

      it("does not run the SMTP port scan for a blocked host", async () => {
        // The port scan is the sharpest edge of the oracle: three raw TCP
        // connects per request, with the result reported back.
        mockDnsLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

        const { POST } = await import("@/app/api/integrations/imap/test/route");
        const response = await POST(makeRequest(validBody), routeContext());
        const body = await response.json();

        expect(mockProbeSmtpPorts).not.toHaveBeenCalled();
        expect(body.smtpPortProbe).toBeUndefined();
        expect(body.suggestion).toBeUndefined();
      });

      it("writes a failure audit entry for a blocked host", async () => {
        mockDnsLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

        const { POST } = await import("@/app/api/integrations/imap/test/route");
        await POST(makeRequest(validBody), routeContext());

        expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
        const entry = mockAppendAuditLog.mock.calls[0][0];
        expect(entry.outcome).toBe("failure");
        // The both-legs-failed shape: a row can carry either code, both, or
        // neither, and the type has to admit all three.
        expect(entry.detail).toEqual({
          imapHost: "imap.example.com",
          smtpHost: "smtp.example.com",
          imapCode: "blocked",
          smtpCode: "blocked",
          emailHash: expect.any(String),
          emailPreview: expect.any(String),
        });
      });

      it("blocks the IMAP leg alone when only the IMAP host is internal", async () => {
        mockDnsLookup.mockImplementation(async (host: string) =>
          host === validBody.imapHost
            ? [{ address: "192.168.1.10", family: 4 }]
            : [{ address: "203.0.113.50", family: 4 }]
        );

        const { POST } = await import("@/app/api/integrations/imap/test/route");
        const response = await POST(makeRequest(validBody), routeContext());
        const body = await response.json();

        expect(body.imap.code).toBe("blocked");
        expect(body.smtp).toEqual({ ok: true });
        expect(ImapFlowMock).not.toHaveBeenCalled();
        expect(createTransportMock).toHaveBeenCalled();
      });
    });

    it("omits the redaction fields entirely for a username that is not email-shaped", async () => {
      // `emailHash`/`emailPreview` are optional in the declared detail shape
      // because not every IMAP username is an email address — a bare login name
      // is not identity data and gets no redaction pair at all.
      const { POST } = await import("@/app/api/integrations/imap/test/route");
      await POST(makeRequest({ ...validBody, username: "mailbox" }), routeContext());

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.detail).toEqual({
        imapHost: "imap.example.com",
        smtpHost: "smtp.example.com",
      });
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
