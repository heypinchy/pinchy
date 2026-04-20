import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/encryption", () => ({
  encrypt: vi.fn((plaintext: string) => `encrypted::${plaintext}`),
  decrypt: vi.fn((ciphertext: string) => ciphertext.replace(/^encrypted::/, "")),
}));

// DB chain: db.select().from() and db.insert().values().returning()
const mockInsertReturning = vi.fn();
const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
const mockSelectFrom = vi.fn();
const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

vi.mock("@/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

import { getSession } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { encrypt, decrypt } from "@/lib/encryption";

const adminSession = {
  user: { id: "admin-1", role: "admin" },
  expires: "",
} as const;

const memberSession = {
  user: { id: "user-1", role: "member" },
  expires: "",
} as const;

describe("GET /api/integrations", () => {
  let GET: typeof import("@/app/api/integrations/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/integrations/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(memberSession as never);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Admin access required" });
  });

  it("returns list with masked Odoo + Pipedrive credentials", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    const now = new Date();
    mockSelectFrom.mockResolvedValueOnce([
      {
        id: "conn-odoo",
        type: "odoo",
        name: "My Odoo",
        description: "",
        status: "active",
        credentials: `encrypted::${JSON.stringify({
          url: "https://odoo.example.com",
          db: "prod",
          login: "admin",
          apiKey: "secret-key",
          uid: 42,
        })}`,
        data: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "conn-pd",
        type: "pipedrive",
        name: "Acme Pipedrive",
        description: "",
        status: "active",
        credentials: `encrypted::${JSON.stringify({
          apiToken: "super-secret",
          companyDomain: "acme",
          companyName: "Acme Corp",
          userId: 1,
          userName: "Alice",
        })}`,
        data: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);

    const odoo = body.find((c: { type: string }) => c.type === "odoo");
    expect(odoo.credentials).toEqual({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
    });
    expect(odoo.credentials.apiKey).toBeUndefined();
    expect(odoo.credentials.uid).toBeUndefined();
    expect(odoo.cannotDecrypt).toBe(false);

    const pipedrive = body.find((c: { type: string }) => c.type === "pipedrive");
    expect(pipedrive.credentials).toEqual({
      companyDomain: "acme",
      companyName: "Acme Corp",
      userName: "Alice",
    });
    expect(pipedrive.credentials.apiToken).toBeUndefined();
    expect(pipedrive.cannotDecrypt).toBe(false);
  });

  it("isolates decrypt failures per row (#159) — one poison row must not hide others", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    const now = new Date();
    mockSelectFrom.mockResolvedValueOnce([
      {
        id: "conn-poison",
        type: "pipedrive",
        name: "Broken (old key)",
        description: "",
        status: "active",
        credentials: "garbled-ciphertext",
        data: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "conn-ok",
        type: "pipedrive",
        name: "Fresh",
        description: "",
        status: "active",
        credentials: `encrypted::${JSON.stringify({
          apiToken: "t",
          companyDomain: "acme",
          companyName: "Acme",
          userId: 1,
          userName: "Alice",
        })}`,
        data: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    // First call (poison row) throws; second call (ok row) uses default mock
    vi.mocked(decrypt).mockImplementationOnce(() => {
      throw new Error("decipher failed");
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);

    const poison = body.find((c: { id: string }) => c.id === "conn-poison");
    expect(poison.cannotDecrypt).toBe(true);
    expect(poison.credentials).toBeNull();
    expect(poison.name).toBe("Broken (old key)");

    const ok = body.find((c: { id: string }) => c.id === "conn-ok");
    expect(ok.cannotDecrypt).toBe(false);
    expect(ok.credentials).toEqual({
      companyDomain: "acme",
      companyName: "Acme",
      userName: "Alice",
    });
  });
});

describe("POST /api/integrations", () => {
  let POST: typeof import("@/app/api/integrations/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/integrations/route");
    POST = mod.POST;
  });

  function makeRequest(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/integrations", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const response = await POST(makeRequest({ type: "pipedrive" }));
    expect(response.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(memberSession as never);
    const response = await POST(makeRequest({ type: "pipedrive" }));
    expect(response.status).toBe(403);
  });

  it("returns 400 on validation failure (missing fields)", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    const response = await POST(makeRequest({ type: "pipedrive", name: "" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details).toBeDefined();
  });

  it("rejects Odoo connection with invalid URL", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    const response = await POST(
      makeRequest({
        type: "odoo",
        name: "Local Odoo",
        credentials: {
          url: "http://localhost:8069",
          db: "prod",
          login: "admin",
          apiKey: "key",
          uid: 1,
        },
      })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/private|localhost|external/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("creates a Pipedrive connection without URL validation", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockInsertReturning.mockResolvedValueOnce([
      {
        id: "new-pd",
        type: "pipedrive",
        name: "Acme Pipedrive",
        description: "",
        status: "active",
        credentials: "ignored-in-response",
        data: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await POST(
      makeRequest({
        type: "pipedrive",
        name: "Acme Pipedrive",
        credentials: {
          apiToken: "token-123",
          companyDomain: "acme",
          companyName: "Acme Corp",
          userId: 7,
          userName: "Alice",
        },
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    // Response credentials are masked (no apiToken)
    expect(body.credentials).toEqual({
      companyDomain: "acme",
      companyName: "Acme Corp",
      userName: "Alice",
    });
    expect(body.credentials.apiToken).toBeUndefined();

    // Encryption called with the full credentials payload
    expect(encrypt).toHaveBeenCalledTimes(1);
    const encryptArg = vi.mocked(encrypt).mock.calls[0][0];
    expect(JSON.parse(encryptArg)).toMatchObject({
      apiToken: "token-123",
      companyDomain: "acme",
    });

    // Audit log written
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        resource: "integration:new-pd",
        detail: expect.objectContaining({
          action: "integration_created",
          type: "pipedrive",
          name: "Acme Pipedrive",
        }),
        outcome: "success",
      })
    );
  });

  it("creates an Odoo connection when URL is valid", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(adminSession as never);
    mockInsertReturning.mockResolvedValueOnce([
      {
        id: "new-odoo",
        type: "odoo",
        name: "Prod Odoo",
        description: "",
        status: "active",
        credentials: "ignored",
        data: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await POST(
      makeRequest({
        type: "odoo",
        name: "Prod Odoo",
        credentials: {
          url: "https://odoo.example.com",
          db: "prod",
          login: "admin",
          apiKey: "key",
          uid: 1,
        },
      })
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    // Odoo mask: url/db/login, no apiKey
    expect(body.credentials).toEqual({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
    });
    expect(body.credentials.apiKey).toBeUndefined();

    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        resource: "integration:new-odoo",
        detail: expect.objectContaining({ type: "odoo", name: "Prod Odoo" }),
      })
    );
  });
});
