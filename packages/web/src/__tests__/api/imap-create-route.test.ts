import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockEncrypt = vi.fn().mockReturnValue("encrypted-imap-creds");
const mockDecrypt = vi.fn();
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  redactEmail: (email: string) => ({ emailDomain: email.split("@")[1] ?? "unknown" }),
  // Faithful stand-in for the real scrubEmails: email-shaped tokens become
  // <email-redacted>, everything else passes through unchanged.
  scrubEmails: (text: string) => text.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "<email-redacted>"),
}));

const mockRecordAuditFailure = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: (...args: unknown[]) => mockRecordAuditFailure(...args),
}));

const mockInsertValues = vi.fn();
const mockInsertReturning = vi.fn();

const insertedConnection = {
  id: "imap-conn-1",
  type: "imap",
  name: "Support Inbox",
  description: "",
  credentials: "encrypted-imap-creds",
  data: { emailAddress: "support@example.com", provider: "imap" },
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: mockInsertValues.mockReturnValue({
        returning: mockInsertReturning,
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

import { NextRequest } from "next/server";
import { routeContext } from "@/test-helpers/route";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:7777/api/integrations/imap", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };
const memberSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const validBody = {
  name: "Support Inbox",
  imapHost: "imap.example.com",
  imapPort: 993,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  username: "support@example.com",
  password: "super-secret-password",
  security: "tls",
};

describe("POST /api/integrations/imap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockInsertReturning.mockResolvedValue([insertedConnection]);
  });

  it("returns 401 when not authenticated and does not insert a row", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest(validBody), routeContext());

    expect(response.status).toBe(401);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin users and does not insert a row", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest(validBody), routeContext());

    expect(response.status).toBe(403);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("creates an IMAP connection, encrypts credentials, and returns a summary", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest(validBody), routeContext());
    const body = await response.json();

    expect(response.status).toBe(201);

    // Credentials must be encrypted before storage — encrypt() is called with
    // the full credential set as a JSON string.
    expect(mockEncrypt).toHaveBeenCalledWith(
      JSON.stringify({
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        username: "support@example.com",
        password: "super-secret-password",
        security: "tls",
      })
    );

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "imap",
        name: "Support Inbox",
        credentials: "encrypted-imap-creds",
        status: "active",
        data: { emailAddress: "support@example.com", provider: "imap" },
      })
    );

    // The stored credentials column must be the ciphertext, never the plaintext password.
    const insertedRow = mockInsertValues.mock.calls[0][0];
    expect(insertedRow.credentials).not.toContain("super-secret-password");

    expect(body).toMatchObject({
      id: "imap-conn-1",
      name: "Support Inbox",
      type: "imap",
      status: "active",
    });
    // The response must never leak the plaintext password either.
    expect(JSON.stringify(body)).not.toContain("super-secret-password");
  });

  it("writes an integration.created audit entry with {id, name} and no password", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    await POST(makeRequest(validBody), routeContext());

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.created",
        outcome: "success",
        actorType: "user",
        actorId: "user-1",
        detail: expect.objectContaining({
          id: "imap-conn-1",
          name: "Support Inbox",
          type: "imap",
        }),
      })
    );

    const auditCall = mockAppendAuditLog.mock.calls[0][0];
    const serializedDetail = JSON.stringify(auditCall.detail);
    expect(serializedDetail).not.toContain("super-secret-password");
    // Username looks like an email address — must not appear in plaintext.
    expect(serializedDetail).not.toContain("support@example.com");
  });

  it("defaults the connection name to the mailbox address when name is omitted", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const { name: _name, ...rest } = validBody;
    mockInsertReturning.mockResolvedValueOnce([{ ...insertedConnection, name: rest.username }]);

    const response = await POST(makeRequest(rest), routeContext());
    const body = await response.json();

    expect(response.status).toBe(201);
    // The DB row and the API response keep the mailbox address as a renameable
    // label — that's not the append-only audit log, so it's fine there.
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ name: rest.username }));
    expect(body.name).toBe(rest.username);

    // But the append-only, HMAC-signed audit `detail` must NOT carry the raw
    // mailbox address (GDPR Art. 17 — unerasable). The defaulted email-shaped
    // name must be scrubbed before it lands in the audit row.
    const auditCall = mockAppendAuditLog.mock.calls[0][0];
    expect(JSON.stringify(auditCall.detail)).not.toContain(rest.username);
    expect(auditCall.detail.name).toBe("<email-redacted>");
  });

  it("returns 400 and does not insert or audit when name is blank", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest({ ...validBody, name: "" }), routeContext());

    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 and does not insert or audit when imapHost is missing", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const { imapHost: _imapHost, ...rest } = validBody;
    const response = await POST(makeRequest(rest), routeContext());

    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 and does not insert or audit when the port is out of range", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest({ ...validBody, imapPort: 999999 }), routeContext());

    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("records an audit failure and returns 500 when the insert throws", async () => {
    mockInsertReturning.mockRejectedValueOnce(new Error("DB unreachable"));
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest(validBody), routeContext());

    expect(response.status).toBe(500);
    expect(mockRecordAuditFailure).toHaveBeenCalled();
    const [, failureEntry] = mockRecordAuditFailure.mock.calls[0];
    expect(failureEntry).toMatchObject({
      eventType: "integration.created",
      outcome: "failure",
    });
    expect(JSON.stringify(failureEntry)).not.toContain("super-secret-password");
  });

  it("scrubs the email-shaped defaulted name from the audit failure detail", async () => {
    mockInsertReturning.mockRejectedValueOnce(new Error("DB unreachable"));
    const { POST } = await import("@/app/api/integrations/imap/route");

    // Name omitted → defaults to the mailbox address, which must not leak into
    // the append-only audit failure row.
    const { name: _name, ...rest } = validBody;
    await POST(makeRequest(rest), routeContext());

    const [, failureEntry] = mockRecordAuditFailure.mock.calls[0];
    expect(JSON.stringify(failureEntry.detail)).not.toContain(rest.username);
    expect(failureEntry.detail.name).toBe("<email-redacted>");
  });

  describe("senderName", () => {
    it("stores senderName inside the encrypted credentials blob", async () => {
      const { POST } = await import("@/app/api/integrations/imap/route");

      await POST(makeRequest({ ...validBody, senderName: "Support Team" }), routeContext());

      expect(mockEncrypt).toHaveBeenCalledWith(
        JSON.stringify({
          imapHost: "imap.example.com",
          imapPort: 993,
          smtpHost: "smtp.example.com",
          smtpPort: 465,
          username: "support@example.com",
          password: "super-secret-password",
          security: "tls",
          senderName: "Support Team",
        })
      );
    });

    it("never puts senderName in the plaintext data column or audit detail", async () => {
      const { POST } = await import("@/app/api/integrations/imap/route");

      await POST(makeRequest({ ...validBody, senderName: "Support Team" }), routeContext());

      const insertedRow = mockInsertValues.mock.calls[0][0];
      expect(JSON.stringify(insertedRow.data)).not.toContain("Support Team");

      const auditCall = mockAppendAuditLog.mock.calls[0][0];
      expect(JSON.stringify(auditCall.detail)).not.toContain("Support Team");
    });

    it("returns 400 when senderName contains CR/LF (header injection guard)", async () => {
      const { POST } = await import("@/app/api/integrations/imap/route");

      const response = await POST(
        makeRequest({ ...validBody, senderName: "x\r\nBcc: evil@example.com" }),
        routeContext()
      );

      expect(response.status).toBe(400);
      expect(mockInsertValues).not.toHaveBeenCalled();
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });
  });
});
