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

const mockFinalize = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/finalize-deletion", () => ({
  finalizeIntegrationDeletion: (...a: unknown[]) => mockFinalize(...a),
}));

const { mockInsertValues, mockSelectFrom, mockSelectDistinctFrom, mockUpdateSet, mockDeleteWhere } =
  vi.hoisted(() => ({
    mockInsertValues: vi.fn(),
    mockSelectFrom: vi.fn(),
    mockSelectDistinctFrom: vi.fn(),
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
  status: "active",
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
    selectDistinct: vi.fn().mockReturnValue({
      from: mockSelectDistinctFrom.mockImplementation(() => {
        // Default: no agents reference this connection (0-permissions happy path)
        const withJoin = {
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        };
        return withJoin;
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
  integrationConnections: { id: "id", type: "type" },
  agentConnectionPermissions: { connectionId: "connectionId", agentId: "agentId" },
  agents: { id: "agentId", name: "agentName" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  sql: vi.fn().mockReturnValue({ as: vi.fn().mockReturnValue({ sql: "mocked-sql" }) }),
}));

const mockDeleteOAuthSettings = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/oauth-settings", () => ({
  deleteOAuthSettings: (...args: unknown[]) => mockDeleteOAuthSettings(...args),
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

  it("should include status field in each connection", async () => {
    const { GET } = await import("@/app/api/integrations/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0]).toHaveProperty("status", "active");
  });

  it("should include pending connections in the list", async () => {
    const pendingConnection = { ...mockConnection, id: "conn-pending", status: "pending" };
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([mockConnection, pendingConnection]) as Promise<
        (typeof mockConnection)[]
      > & { where: ReturnType<typeof vi.fn> };
      result.where = vi.fn().mockResolvedValue([mockConnection, pendingConnection]);
      return result;
    });

    const { GET } = await import("@/app/api/integrations/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.find((c: { status: string }) => c.status === "pending")).toBeDefined();
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

  it("listing includes agentUsageCount per row", async () => {
    // The real query uses db.select({...subquery...}).from(integrationConnections),
    // which yields rows enriched with agentUsageCount. The mock simulates that
    // enriched result. The route must pass agentUsageCount through to the response.
    const connectionWithCount = { ...mockConnection, agentUsageCount: 3 };
    mockSelectFrom.mockImplementationOnce(() => Promise.resolve([connectionWithCount]));

    const { GET } = await import("@/app/api/integrations/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0]).toHaveProperty("agentUsageCount");
    expect(typeof body[0].agentUsageCount).toBe("number");
    expect(body[0].agentUsageCount).toBe(3);
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

  it("should return 409 when creating a duplicate web-search connection", async () => {
    // Mock: existing web-search connection found
    mockSelectFrom.mockImplementationOnce(() => {
      const webConn = { ...mockConnection, id: "ws-existing", type: "web-search" };
      const result = Promise.resolve([webConn]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([webConn]);
      return result;
    });

    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        type: "web-search",
        name: "Brave Search",
        credentials: { apiKey: "BSA-test-key" },
      }),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("already exists");
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

  it("should accept web-search credentials for web-search connections", async () => {
    const webSearchConnection = {
      ...mockConnection,
      id: "ws-1",
      type: "web-search",
      name: "Brave Search",
    };
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([webSearchConnection]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([webSearchConnection]);
      return result;
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/ws-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: { apiKey: "new-brave-key" } }),
      }),
      { params: Promise.resolve({ connectionId: "ws-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockEncrypt).toHaveBeenCalledWith(JSON.stringify({ apiKey: "new-brave-key" }));
  });

  it("should reject odoo credentials for web-search connections", async () => {
    const webSearchConnection = {
      ...mockConnection,
      id: "ws-1",
      type: "web-search",
      name: "Brave Search",
    };
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([webSearchConnection]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([webSearchConnection]);
      return result;
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/ws-1", {
        method: "PATCH",
        body: JSON.stringify({
          credentials: { url: "https://odoo.example.com", db: "prod", login: "admin", apiKey: "x" },
        }),
      }),
      { params: Promise.resolve({ connectionId: "ws-1" }) }
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

  it("should delete connection and call finalize helper", async () => {
    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await DELETE(makeRequest("/api/integrations/conn-1", { method: "DELETE" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockDeleteWhere).toHaveBeenCalled();
    expect(mockFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "user-1",
        connection: expect.objectContaining({ id: "conn-1", type: "odoo", name: "Test Odoo" }),
        detachedAgents: [],
      })
    );
  });

  it("should pass connection to finalize helper when deleting a Google connection", async () => {
    const googleConnection = { ...mockConnection, id: "conn-google-1", type: "google" };
    mockSelectFrom.mockImplementationOnce(() => {
      const r = Promise.resolve([googleConnection]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      r.where = vi.fn().mockResolvedValue([googleConnection]);
      return r;
    });

    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");
    const response = await DELETE(
      makeRequest("/api/integrations/conn-google-1", { method: "DELETE" }),
      { params: Promise.resolve({ connectionId: "conn-google-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mockFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ id: "conn-google-1", type: "google" }),
      })
    );
  });
});

describe("DELETE /api/integrations/:id — strict permission check", () => {
  const deleteReq = makeRequest("/api/integrations/conn-1", { method: "DELETE" });
  const deleteCtx = { params: Promise.resolve({ connectionId: "conn-1" }) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: "u1", email: "admin@test.com", role: "admin" },
    });
    mockFinalize.mockClear();
    // Default: select finds the connection
    mockSelectFrom.mockImplementation(() => {
      const r = Promise.resolve([mockConnection]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      r.where = vi.fn().mockResolvedValue([mockConnection]);
      return r;
    });
    // Default: selectDistinct returns [] (no permissions — happy path)
    mockSelectDistinctFrom.mockImplementation(() => ({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }));
    // Default: delete succeeds
    mockDeleteWhere.mockResolvedValue(undefined);
  });

  // Task 3: 0-permissions happy path uses finalize helper
  it("deletes integration and calls finalize helper when no permissions exist", async () => {
    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");
    const res = await DELETE(deleteReq, deleteCtx);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "u1",
        connection: expect.objectContaining({ id: "conn-1" }),
        detachedAgents: [],
      })
    );
  });

  // Task 4: 409 with agent list when permissions reference the integration
  it("returns 409 with agents list when permissions reference the integration", async () => {
    // selectDistinct returns one agent referencing this connection
    mockSelectDistinctFrom.mockImplementationOnce(() => ({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "a1", name: "Bot" }]),
      }),
    }));

    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");
    const res = await DELETE(deleteReq, deleteCtx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: "Integration has active permissions",
      agents: [{ id: "a1", name: "Bot" }],
    });
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  // Task 5: TOCTOU — FK violation during delete falls back to 409
  it("returns 409 (not 500) when FK violation occurs during delete (TOCTOU)", async () => {
    // Preflight selectDistinct returns [] — looks safe
    // But db.delete throws a FK violation (TOCTOU: permission inserted between check and delete)
    const fkError = Object.assign(new Error("FK violation"), { code: "23503" });
    mockDeleteWhere.mockRejectedValueOnce(fkError);

    // Second selectDistinct call (re-fetch after FK error) returns an agent
    mockSelectDistinctFrom
      .mockImplementationOnce(() => ({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // preflight — no permissions yet
        }),
      }))
      .mockImplementationOnce(() => ({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "a2", name: "B" }]), // re-fetch after FK error
        }),
      }));

    const { DELETE } = await import("@/app/api/integrations/[connectionId]/route");
    const res = await DELETE(deleteReq, deleteCtx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Integration has active permissions");
    expect(body.agents).toEqual([{ id: "a2", name: "B" }]);
    expect(mockFinalize).not.toHaveBeenCalled();
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

describe("POST /api/integrations/[connectionId]/test (web-search)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  const webSearchConnection = {
    ...mockConnection,
    id: "conn-ws-1",
    type: "web-search",
    name: "Brave Search",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    mockDecrypt.mockReturnValue(JSON.stringify({ apiKey: "BSA-valid-key" }));
    mockSelectFrom.mockImplementation(() => {
      const result = Promise.resolve([webSearchConnection]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([webSearchConnection]);
      return result;
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mockDecrypt.mockReturnValue(
      JSON.stringify({
        url: "https://odoo.example.com",
        db: "prod",
        login: "admin",
        apiKey: "secret-key",
        uid: 2,
      })
    );
  });

  it("should return success when Brave API key is valid", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(
      makeRequest("/api/integrations/conn-ws-1/test", { method: "POST" }),
      { params: Promise.resolve({ connectionId: "conn-ws-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
      { headers: { "X-Subscription-Token": "BSA-valid-key" } }
    );
  });

  it("should return error when Brave API key is invalid", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(
      makeRequest("/api/integrations/conn-ws-1/test", { method: "POST" }),
      { params: Promise.resolve({ connectionId: "conn-ws-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid API key");
  });

  it("should return error when credentials have no apiKey", async () => {
    mockDecrypt.mockReturnValueOnce(JSON.stringify({}));
    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(
      makeRequest("/api/integrations/conn-ws-1/test", { method: "POST" }),
      { params: Promise.resolve({ connectionId: "conn-ws-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid credentials format");
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

describe("POST /api/integrations/test-credentials (web-search)", () => {
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

  it("should return success for valid Brave API key", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "web-search",
          credentials: { apiKey: "BSAxxxxxxxxxxxxxxxxxxxxxxxx" },
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.search.brave.com/res/v1/web/search?q=test&count=1",
      { headers: { "X-Subscription-Token": "BSAxxxxxxxxxxxxxxxxxxxxxxxx" } }
    );
  });

  it("should return error for invalid Brave API key", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "web-search",
          credentials: { apiKey: "invalid-key" },
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid API key");
  });

  it("should return error when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "web-search",
          credentials: { apiKey: "BSAxxxxxxxxxxxxxxxxxxxxxxxx" },
        }),
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Network error");
  });

  it("should return 400 when apiKey is missing", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const response = await POST(
      makeRequest("/api/integrations/test-credentials", {
        method: "POST",
        body: JSON.stringify({
          type: "web-search",
          credentials: {},
        }),
      })
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/integrations (web-search)", () => {
  // Helper: mock the duplicate-check select to return empty (no existing web-search)
  function mockNoDuplicateWebSearch() {
    mockSelectFrom.mockImplementationOnce(() => {
      const result = Promise.resolve([]) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      result.where = vi.fn().mockResolvedValue([]);
      return result;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("should create a web-search integration", async () => {
    mockNoDuplicateWebSearch();
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        type: "web-search",
        name: "Brave Search",
        credentials: { apiKey: "BSAxxxxxxxxxxxxxxxxxxxxxxxx" },
      }),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockEncrypt).toHaveBeenCalledWith(
      JSON.stringify({ apiKey: "BSAxxxxxxxxxxxxxxxxxxxxxxxx" })
    );
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "web-search",
        name: "Brave Search",
        credentials: "encrypted-creds",
        data: null,
      })
    );
    // Response should have masked credentials (not the API key)
    expect(body.credentials).toEqual({ configured: true });
    expect(body.credentials).not.toHaveProperty("apiKey");
  });

  it("should call appendAuditLog on create", async () => {
    mockNoDuplicateWebSearch();
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        type: "web-search",
        name: "Brave Search",
        credentials: { apiKey: "BSAxxxxxxxxxxxxxxxxxxxxxxxx" },
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
          type: "web-search",
          name: "Brave Search",
        }),
        outcome: "success",
      })
    );
  });

  it("should return 400 when apiKey is missing for web-search", async () => {
    const { POST } = await import("@/app/api/integrations/route");

    const request = makeRequest("/api/integrations", {
      method: "POST",
      body: JSON.stringify({
        type: "web-search",
        name: "Brave Search",
        credentials: {},
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe("GET /api/integrations (web-search masking)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
  });

  it("should return { configured: true } for web-search connections", async () => {
    const webSearchConnection = {
      ...mockConnection,
      id: "conn-ws-1",
      type: "web-search",
      name: "Brave Search",
    };
    mockSelectFrom.mockImplementationOnce(() => Promise.resolve([webSearchConnection]));
    // No mockDecrypt override needed — maskConnectionCredentials for web-search
    // returns { configured: true } without calling decrypt

    const { GET } = await import("@/app/api/integrations/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body[0].credentials).toEqual({ configured: true });
    expect(body[0].credentials).not.toHaveProperty("apiKey");
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
