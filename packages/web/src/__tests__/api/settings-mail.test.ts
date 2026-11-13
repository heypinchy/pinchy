import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { makeNextRequest } from "@/test-helpers/route";

vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/api-auth", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  redactEmail: (email: string) => ({ emailHash: `hash-${email.length}`, emailPreview: "p…y@x" }),
}));

let stored: Record<string, unknown> | null = null;
vi.mock("@/lib/system-mail/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/system-mail/config")>();
  return {
    ...actual,
    getSystemMailConfig: vi.fn(async () => stored),
    saveSystemMailConfig: vi.fn(async (c: Record<string, unknown>) => {
      stored = c;
    }),
    deleteSystemMailConfig: vi.fn(async () => {
      stored = null;
    }),
  };
});

const mockVerify = vi.fn();
vi.mock("@/lib/system-mail/transport", () => ({
  verifySystemMail: (...args: unknown[]) => mockVerify(...args),
}));

const mockDeliverTest = vi.fn();
vi.mock("@/lib/system-mail/deliver", () => ({
  deliverTestEmail: (...args: unknown[]) => mockDeliverTest(...args),
}));

import { GET, PUT, DELETE } from "@/app/api/settings/mail/route";
import { POST as TEST_POST } from "@/app/api/settings/mail/test/route";
import { saveSystemMailConfig, deleteSystemMailConfig } from "@/lib/system-mail/config";

const adminSession = { user: { id: "admin-1", email: "admin@example.com", role: "admin" } };

const body = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "pinchy@example.com",
  password: "s3cret",
  fromAddress: "pinchy@example.com",
};

function put(payload: unknown) {
  return makeNextRequest("http://localhost/api/settings/mail", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  mockRequireAdmin.mockResolvedValue(adminSession);
  mockVerify.mockResolvedValue(undefined);
});

describe("admin gate", () => {
  it.each([
    ["GET", () => GET()],
    ["PUT", () => PUT(put(body))],
    ["DELETE", () => DELETE()],
    [
      "POST test",
      () =>
        TEST_POST(
          makeNextRequest("http://localhost/api/settings/mail/test", {
            method: "POST",
            body: "{}",
          })
        ),
    ],
  ])("%s is admin-only", async (_name, call) => {
    mockRequireAdmin.mockResolvedValueOnce(NextResponse.json({}, { status: 403 }));
    expect((await call()).status).toBe(403);
  });
});

describe("GET /api/settings/mail", () => {
  it("reports off when nothing is configured", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ configured: false });
  });

  it("never returns the password", async () => {
    stored = { ...body, security: "starttls" };
    const res = await GET();
    const json = await res.json();
    expect(json.configured).toBe(true);
    expect(json.config.hasPassword).toBe(true);
    expect(JSON.stringify(json)).not.toContain("s3cret");
  });
});

describe("PUT /api/settings/mail", () => {
  it("verifies the connection before saving", async () => {
    const res = await PUT(put(body));
    expect(res.status).toBe(200);
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ host: "smtp.example.com" }));
    expect(saveSystemMailConfig).toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain("s3cret");
  });

  it("saves nothing when verification fails, and says what to fix", async () => {
    mockVerify.mockRejectedValueOnce(new Error("Invalid login: 535 5.7.8"));
    const res = await PUT(put(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Authentication failed — check the username and password"
    );
    expect(saveSystemMailConfig).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "settings.updated",
        resource: "settings:mail",
        outcome: "failure",
        error: { message: "Authentication failed — check the username and password" },
      })
    );
  });

  it("rejects an invalid body with a structured 400", async () => {
    const res = await PUT(put({ ...body, fromAddress: "not-an-address" }));
    expect(res.status).toBe(400);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it("audits what changed, and the password only as a flag", async () => {
    await PUT(put(body));
    const entry = mockAppendAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      actorType: "user",
      actorId: "admin-1",
      eventType: "settings.updated",
      resource: "settings:mail",
      outcome: "success",
      detail: {
        changes: {
          host: { from: null, to: "smtp.example.com" },
          port: { from: null, to: 587 },
          fromAddress: { from: null, to: { emailHash: "hash-18", emailPreview: "p…y@x" } },
          username: { from: null, to: { emailHash: "hash-18", emailPreview: "p…y@x" } },
        },
        passwordChanged: true,
      },
    });
    expect(JSON.stringify(entry)).not.toContain("s3cret");
  });

  it("never writes an email address into the audit row in plain text", async () => {
    stored = { ...body, username: "jane.doe@gmail.com", fromAddress: "jane.doe@gmail.com" };
    await PUT(put({ ...body, username: "it@acme.io", fromAddress: "it@acme.io" }));
    await DELETE();
    mockVerify.mockRejectedValueOnce(new Error("Invalid login: 535"));
    await PUT(put({ ...body, username: "bob@acme.io", fromAddress: "bob@acme.io" }));
    const all = JSON.stringify(mockAppendAuditLog.mock.calls);
    for (const address of [
      "jane.doe@gmail.com",
      "it@acme.io",
      "bob@acme.io",
      "pinchy@example.com",
    ]) {
      expect(all).not.toContain(address);
    }
  });

  it("never writes a username that isn't an address into the audit row, only that it changed", async () => {
    stored = { ...body, username: "AKIA-old-service-user" };
    await PUT(put({ ...body, username: "apikey-8f3a" }));
    const entry = mockAppendAuditLog.mock.calls[0][0];
    expect(entry.detail.changes.username).toEqual({ from: "(set)", to: "(set)" });
    expect(JSON.stringify(mockAppendAuditLog.mock.calls)).not.toMatch(/apikey-8f3a|AKIA-old/);
  });

  it("refuses to carry the stored password over to plaintext SMTP and asks for it again", async () => {
    stored = { ...body };
    const res = await PUT(put({ ...body, password: undefined, security: "none", port: 25 }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Validation failed");
    expect(json.details.fieldErrors.password).toEqual([
      expect.stringMatching(/enter the password/i),
    ]);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(saveSystemMailConfig).not.toHaveBeenCalled();
  });

  it("accepts the downgrade once the password is typed again", async () => {
    stored = { ...body };
    const res = await PUT(put({ ...body, password: "s3cret", security: "none", port: 25 }));
    expect(res.status).toBe(200);
  });

  it("keeps the stored password when the form sends none", async () => {
    stored = { ...body };
    // JSON drops the undefined password: the form sends none.
    await PUT(put({ ...body, password: undefined, fromName: "Acme IT" }));
    expect(mockVerify).toHaveBeenCalledWith(expect.objectContaining({ password: "s3cret" }));
    expect(stored).toMatchObject({ password: "s3cret", fromName: "Acme IT" });
    const entry = mockAppendAuditLog.mock.calls[0][0];
    expect(entry.detail.changes).toEqual({ fromName: { from: null, to: "Acme IT" } });
    expect(entry.detail.passwordChanged).toBe(false);
  });
});

describe("DELETE /api/settings/mail", () => {
  it("turns the mailer off and audits every field going to null", async () => {
    stored = { ...body };
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(stored).toBeNull();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "settings.updated",
        resource: "settings:mail",
        outcome: "success",
        detail: expect.objectContaining({
          changes: expect.objectContaining({ host: { from: "smtp.example.com", to: null } }),
        }),
      })
    );
  });

  it("answers 404 when there is nothing to turn off, and deletes nothing unaudited", async () => {
    expect((await DELETE()).status).toBe(404);
    expect(deleteSystemMailConfig).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });
});

describe("POST /api/settings/mail/test", () => {
  function testRequest() {
    return makeNextRequest("http://localhost/api/settings/mail/test", {
      method: "POST",
      body: "{}",
    });
  }

  it("sends to the signed-in admin with the saved config", async () => {
    stored = { ...body };
    mockDeliverTest.mockResolvedValue({ sent: true });
    const res = await TEST_POST(testRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true, to: "admin@example.com" });
    expect(mockDeliverTest).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com", actorId: "admin-1" })
    );
  });

  it("returns the send error as a 502 the card can show", async () => {
    stored = { ...body };
    mockDeliverTest.mockResolvedValue({ sent: false, error: "Connection refused" });
    const res = await TEST_POST(testRequest());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Connection refused");
  });

  it("answers with an error, not a 500, if sending itself crashes", async () => {
    stored = { ...body };
    mockDeliverTest.mockRejectedValue(new Error("boom"));
    const res = await TEST_POST(testRequest());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Something went wrong sending the email.");
  });

  it("refuses when no mailer is configured", async () => {
    const res = await TEST_POST(testRequest());
    expect(res.status).toBe(409);
    expect(mockDeliverTest).not.toHaveBeenCalled();
  });
});
