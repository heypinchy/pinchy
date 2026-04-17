import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockEncrypt = vi.fn().mockReturnValue("encrypted-creds");
const mockDecrypt = vi.fn().mockReturnValue(
  JSON.stringify({
    url: "https://odoo.example.com",
    db: "prod",
    login: "admin",
    apiKey: "secret-key",
    uid: 2,
  })
);
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

const { mockAuthenticate, mockVersion, mockModels, mockFields, mockCheckAccessRights } = vi.hoisted(
  () => ({
    mockAuthenticate: vi.fn(),
    mockVersion: vi.fn(),
    mockModels: vi.fn(),
    mockFields: vi.fn(),
    mockCheckAccessRights: vi.fn().mockResolvedValue(true),
  })
);

vi.mock("odoo-node", () => {
  function OdooClient() {
    return {
      version: mockVersion,
      models: mockModels,
      fields: mockFields,
      checkAccessRights: mockCheckAccessRights,
    };
  }
  OdooClient.authenticate = mockAuthenticate;
  return { OdooClient };
});

const { mockInsertValues, mockSelectFrom, mockUpdateSet, mockDeleteWhere } = vi.hoisted(() => ({
  mockInsertValues: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockDeleteWhere: vi.fn(),
}));

const mockConnection = {
  id: "conn-1",
  type: "odoo",
  name: "Test Odoo",
  description: "Test connection",
  credentials: "encrypted-creds",
  data: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: mockInsertValues.mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockConnection]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: mockSelectFrom.mockImplementation(() => {
        // Return a thenable with .where() — handles both list (await directly) and single-item (await .where()) cases
        const result = Promise.resolve([mockConnection]) as Promise<(typeof mockConnection)[]> & {
          where: ReturnType<typeof vi.fn>;
        };
        result.where = vi.fn().mockResolvedValue([mockConnection]);
        return result;
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: mockUpdateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...mockConnection, name: "Updated Odoo" }]),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: mockDeleteWhere.mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

import { NextRequest } from "next/server";

function makeRequest(path: string, options?: RequestInit) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };
const memberSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const validCredentials = {
  url: "https://odoo.example.com",
  db: "prod",
  login: "admin",
  apiKey: "secret-key",
  uid: 2,
};

describe("GET /api/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/integrations/route");

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { GET } = await import("@/app/api/integrations/route");

    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("should return connections with masked credentials", async () => {
    const { GET } = await import("@/app/api/integrations/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toHaveProperty("credentials");
    expect(body[0].credentials).toEqual({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
    });
    // Must NOT contain apiKey or uid
    expect(body[0].credentials).not.toHaveProperty("apiKey");
    expect(body[0].credentials).not.toHaveProperty("uid");
  });

  it("flags a row instead of crashing when its credentials can't be decrypted", async () => {
    // Regression: if the ENCRYPTION_KEY changes (deliberately or accidentally),
    // existing rows can't be decrypted. The .map(decrypt) previously threw,
    // returning 500 — so the UI silently rendered "No integrations configured yet"
    // and ALL other rows disappeared too, including ones encrypted with the
    // current key. The endpoint must degrade gracefully, one row at a time.
    const unreadable = { ...mockConnection, id: "unreadable-1", name: "Old Odoo" };
    const readable = { ...mockConnection, id: "readable-1", name: "New Odoo" };

    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([unreadable, readable]) as Promise<
        (typeof mockConnection)[]
      > & { where: ReturnType<typeof vi.fn> };
      result.where = vi.fn().mockResolvedValue([unreadable, readable]);
      return result;
    });
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    const { GET } = await import("@/app/api/integrations/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);

    const u = body.find((r: { id: string }) => r.id === "unreadable-1");
    expect(u).toMatchObject({
      id: "unreadable-1",
      name: "Old Odoo",
      cannotDecrypt: true,
      credentials: null,
    });

    const r = body.find((r: { id: string }) => r.id === "readable-1");
    expect(r).toMatchObject({
      id: "readable-1",
      name: "New Odoo",
      cannotDecrypt: false,
      credentials: { url: "https://odoo.example.com", db: "prod", login: "admin" },
    });
  });

  it("never exposes credentials for an unreadable row", async () => {
    // Defense in depth: even if decrypt fails, we must not return partial
    // ciphertext or apiKey fragments. The row carries name/id only.
    const unreadable = { ...mockConnection, id: "unreadable-1", credentials: "poisoned:data" };
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([unreadable]) as Promise<(typeof mockConnection)[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([unreadable]);
      return result;
    });
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error("auth tag failed");
    });

    const { GET } = await import("@/app/api/integrations/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0].credentials).toBeNull();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("poisoned");
    expect(serialized).not.toContain("apiKey");
  });
});

describe("POST /api/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({ type: "odoo", name: "Test", credentials: validCredentials }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({ type: "odoo", name: "Test", credentials: validCredentials }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  it("should return 400 for invalid type", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({ type: "shopify", name: "Test", credentials: validCredentials }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should return 400 when name is missing", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({ type: "odoo", name: "", credentials: validCredentials }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should return 400 for invalid credentials", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        type: "odoo",
        name: "Test",
        credentials: { url: "not-a-url", db: "", login: "", apiKey: "", uid: -1 },
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("should encrypt credentials and create connection", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        type: "odoo",
        name: "Prod Odoo",
        description: "Production instance",
        credentials: validCredentials,
      }),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify(validCredentials));
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "odoo",
        name: "Prod Odoo",
        description: "Production instance",
        credentials: "encrypted-creds",
      })
    );
    // Response should have masked credentials
    expect(body.credentials).toEqual({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
    });
  });

  it("should call appendAuditLog on create", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        type: "odoo",
        name: "Prod Odoo",
        credentials: validCredentials,
      }),
    });
    await POST(request);

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "user-1",
        eventType: "config.changed",
        detail: expect.objectContaining({
          action: "integration_created",
          type: "odoo",
          name: "Prod Odoo",
        }),
      })
    );
  });
});

describe("GET /api/integrations/[connectionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await GET(makeRequest("/api/integrations/conn-1"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { GET } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await GET(makeRequest("/api/integrations/conn-1"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(403);
  });

  it("should return 404 when connection not found", async () => {
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([]);
      return result;
    });
    const { GET } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await GET(makeRequest("/api/integrations/nonexistent"), {
      params: Promise.resolve({ connectionId: "nonexistent" }),
    });
    expect(response.status).toBe(404);
  });

  it("should return connection with masked credentials", async () => {
    const { GET } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await GET(makeRequest("/api/integrations/conn-1"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.credentials).toEqual({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
    });
    expect(body.credentials).not.toHaveProperty("apiKey");
  });
});

describe("PATCH /api/integrations/[connectionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );
    expect(response.status).toBe(403);
  });

  it("should return 404 when connection not found", async () => {
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([]);
      return result;
    });
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/nonexistent", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      }),
      { params: Promise.resolve({ connectionId: "nonexistent" }) }
    );
    expect(response.status).toBe(404);
  });

  it("should update name and audit log the change", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated Odoo" }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({ name: "Updated Odoo" }));
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        detail: expect.objectContaining({
          action: "integration_updated",
          id: "conn-1",
          changes: expect.objectContaining({
            name: { from: "Test Odoo", to: "Updated Odoo" },
          }),
        }),
      })
    );
  });

  it("should re-encrypt credentials when updated", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const newCreds = { ...validCredentials, apiKey: "new-secret" };
    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: newCreds }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify(newCreds));
  });

  it("should return 400 for invalid credentials on update", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: { url: "bad" } }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/integrations/[connectionId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await DELETE(makeRequest("/api/integrations/conn-1", { method: "DELETE" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await DELETE(makeRequest("/api/integrations/conn-1", { method: "DELETE" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(403);
  });

  it("should return 404 when connection not found", async () => {
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([]);
      return result;
    });
    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await DELETE(
      makeRequest("/api/integrations/nonexistent", { method: "DELETE" }),
      { params: Promise.resolve({ connectionId: "nonexistent" }) }
    );
    expect(response.status).toBe(404);
  });

  it("should delete connection and audit log", async () => {
    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await DELETE(makeRequest("/api/integrations/conn-1", { method: "DELETE" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockDeleteWhere).toHaveBeenCalled();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config.changed",
        detail: expect.objectContaining({
          action: "integration_deleted",
          type: "odoo",
          name: "Test Odoo",
        }),
      })
    );
  });
});

describe("POST /api/integrations/[connectionId]/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockAuthenticate.mockResolvedValue(2);
    mockVersion.mockResolvedValue({ serverVersion: "17.0" });
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(403);
  });

  it("should return 404 when connection not found", async () => {
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([]);
      return result;
    });
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(404);
  });

  it("should authenticate and return version on success", async () => {
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.version).toBe("17.0");
    expect(body.uid).toBe(2);
    expect(mockAuthenticate).toHaveBeenCalledWith({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
      apiKey: "secret-key",
    });
    expect(mockVersion).toHaveBeenCalled();
  });

  it("should return error when authentication fails", async () => {
    mockAuthenticate.mockRejectedValueOnce(new Error("Authentication failed"));
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication failed");
  });

  it("should update uid when it changes", async () => {
    mockAuthenticate.mockResolvedValueOnce(5);
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.uid).toBe(5);
    expect(mockEncrypt).toHaveBeenCalledWith(
      JSON.stringify({
        url: "https://odoo.example.com",
        db: "prod",
        login: "admin",
        apiKey: "secret-key",
        uid: 5,
      })
    );
  });
});

describe("POST /api/integrations/test-credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockAuthenticate.mockResolvedValue(2);
    mockVersion.mockResolvedValue({ serverVersion: "17.0" });
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "odoo",
          credentials: {
            url: "https://odoo.example.com",
            db: "prod",
            login: "admin",
            apiKey: "key",
          },
        }),
      })
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "odoo",
          credentials: {
            url: "https://odoo.example.com",
            db: "prod",
            login: "admin",
            apiKey: "key",
          },
        }),
      })
    );
    expect(response.status).toBe(403);
  });

  it("should return 400 for invalid type", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "shopify",
          credentials: {
            url: "https://odoo.example.com",
            db: "prod",
            login: "admin",
            apiKey: "key",
          },
        }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("should return 400 for missing credentials fields", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "odoo",
          credentials: { url: "not-a-url" },
        }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("should return success with version and uid on valid credentials", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "odoo",
          credentials: {
            url: "https://odoo.example.com",
            db: "prod",
            login: "admin",
            apiKey: "key",
          },
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.version).toBe("17.0");
    expect(body.uid).toBe(2);
    expect(mockAuthenticate).toHaveBeenCalledWith({
      url: "https://odoo.example.com",
      db: "prod",
      login: "admin",
      apiKey: "key",
    });
    expect(mockVersion).toHaveBeenCalled();
  });

  it("should return error when authentication fails", async () => {
    mockAuthenticate.mockRejectedValueOnce(new Error("Invalid API key"));
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "odoo",
          credentials: {
            url: "https://odoo.example.com",
            db: "prod",
            login: "admin",
            apiKey: "bad-key",
          },
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid API key");
  });
});

describe("POST /api/integrations/list-databases", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      makeRequest("/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({ url: "https://odoo.example.com" }),
      })
    );
    expect(response.status).toBe(401);
  });

  it("should return 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      makeRequest("/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({ url: "https://odoo.example.com" }),
      })
    );
    expect(response.status).toBe(403);
  });

  it("should return 400 when url is missing", async () => {
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      makeRequest("/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(400);
  });

  it("should return 400 when url is invalid", async () => {
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      makeRequest("/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({ url: "not-a-url" }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("should return databases on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: ["production", "staging"] }),
    });
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      makeRequest("/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({ url: "https://odoo.example.com" }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.databases).toEqual(["production", "staging"]);
    expect(mockFetch).toHaveBeenCalledWith("https://odoo.example.com/web/database/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "call", params: {} }),
    });
  });

  it("should return error when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      makeRequest("/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({ url: "https://odoo.example.com" }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Could not list databases");
  });

  it("should return error when Odoo returns error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "Access denied", code: 200, data: {} },
      }),
    });
    const { POST } = await import("@/app/api/integrations/list-databases/route");

    const response = await POST(
      makeRequest("/api/integrations/list-databases", {
        method: "POST",
        body: JSON.stringify({ url: "https://odoo.example.com" }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Could not list databases");
  });
});

describe("POST /api/integrations/[connectionId]/sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockModels.mockResolvedValue([
      { model: "sale.order", name: "Sales Order" },
      { model: "res.partner", name: "Contact" },
      { model: "ir.model", name: "Model" }, // should be filtered out
    ]);
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char", required: true, readonly: false },
    ]);
  });

  it("should return 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(401);
  });

  it("should return 404 when connection not found", async () => {
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([]);
      return result;
    });
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    expect(response.status).toBe(404);
  });

  it("should sync models by probing fields_get and return count", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char", required: true, readonly: false },
    ]);
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.models).toBeGreaterThan(0);
    expect(body.lastSyncAt).toBeDefined();
    // Should call fields_get for each curated model, not client.models()
    expect(mockFields).toHaveBeenCalled();
    expect(mockModels).not.toHaveBeenCalled();
  });

  it("should include resource field in audit log on sync", async () => {
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    await POST(makeRequest("/api/integrations/conn-1/sync", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: "integration:conn-1",
      })
    );
  });

  it("should return error when all models are inaccessible", async () => {
    mockFields.mockRejectedValue(new Error("AccessError"));
    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Could not access any Odoo models");
  });
});
