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
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  redactEmail: (email: string) => ({ emailDomain: email.split("@")[1] ?? "unknown" }),
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

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(401);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 for non-admin users and does not insert a row", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(403);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("creates an IMAP connection, encrypts credentials, and returns a summary", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest(validBody));
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

    await POST(makeRequest(validBody));

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

  it("returns 400 and does not insert or audit when name is missing", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const { name: _name, ...rest } = validBody;
    const response = await POST(makeRequest(rest));

    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 and does not insert or audit when imapHost is missing", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const { imapHost: _imapHost, ...rest } = validBody;
    const response = await POST(makeRequest(rest));

    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 and does not insert or audit when the port is out of range", async () => {
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest({ ...validBody, imapPort: 999999 }));

    expect(response.status).toBe(400);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("records an audit failure and returns 500 when the insert throws", async () => {
    mockInsertReturning.mockRejectedValueOnce(new Error("DB unreachable"));
    const { POST } = await import("@/app/api/integrations/imap/route");

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(500);
    expect(mockRecordAuditFailure).toHaveBeenCalled();
    const [, failureEntry] = mockRecordAuditFailure.mock.calls[0];
    expect(failureEntry).toMatchObject({
      eventType: "integration.created",
      outcome: "failure",
    });
    expect(JSON.stringify(failureEntry)).not.toContain("super-secret-password");
  });
});
