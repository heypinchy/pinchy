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

const mockProbeIntegrationCredentials = vi.fn();
vi.mock("@/lib/integrations/probe", () => ({
  probeIntegrationCredentials: (...args: unknown[]) => mockProbeIntegrationCredentials(...args),
}));

const mockListMcpTools = vi.fn();
vi.mock("@/lib/integrations/mcp-client", () => ({
  listMcpTools: (...args: unknown[]) => mockListMcpTools(...args),
  mcpErrorCodeFromError: () => "unauthorized",
}));

const mockClearIntegrationAuthError = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/auth-state", () => ({
  clearIntegrationAuthError: (...args: unknown[]) => mockClearIntegrationAuthError(...args),
  setIntegrationAuthFailed: vi.fn().mockResolvedValue(undefined),
}));

const { mockUpdateSet, mockSelectWhere } = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockSelectWhere: vi.fn(),
}));

const mockOdooConnection = {
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
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: mockUpdateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...mockOdooConnection, name: "Test Odoo" }]),
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));

vi.mock("@/lib/integrations/odoo-schema", () => {
  // The route calls odooCredentialsSchema.partial() to allow partial updates.
  // The partial schema accepts any subset of odoo fields (no required fields check).
  const partialSchema = {
    safeParse: (data: unknown) => {
      return { success: true, data };
    },
  };
  const odooCredentialsSchema = {
    partial: () => partialSchema,
    safeParse: (data: unknown) => {
      const d = data as Record<string, unknown>;
      if (
        typeof d.url === "string" &&
        d.url.startsWith("https://") &&
        d.db &&
        d.login &&
        d.apiKey
      ) {
        return { success: true, data: d };
      }
      return { success: false, error: { errors: [{ message: "Invalid credentials" }] } };
    },
  };
  return { odooCredentialsSchema };
});

vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: (url: string) => {
    if (url.startsWith("https://")) return { valid: true };
    return { valid: false, error: "URL must use HTTPS" };
  },
}));

vi.mock("@/lib/integrations/mask-credentials", () => ({
  maskConnectionCredentials: (_type: string, _creds: unknown, _decrypt: unknown) => ({
    url: "https://odoo.example.com",
    db: "prod",
    login: "admin",
  }),
}));

vi.mock("@/lib/integrations/oauth-settings", () => ({
  deleteOAuthSettings: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";

function makeRequest(path: string, options?: RequestInit) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };

const validOdooCredentials = {
  url: "https://odoo.example.com",
  db: "prod",
  login: "admin",
  apiKey: "secret-key",
  uid: 2,
};

describe("PATCH /api/integrations/[connectionId] — credential probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockSelectWhere.mockResolvedValue([mockOdooConnection]);
    mockProbeIntegrationCredentials.mockResolvedValue({ success: true });
    mockDecrypt.mockReturnValue(JSON.stringify(validOdooCredentials));
    mockEncrypt.mockReturnValue("encrypted-creds");
  });

  it("PATCH with new credentials probes upstream and updates on success", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const newCredentials = { ...validOdooCredentials, apiKey: "new-secret-key" };
    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: newCredentials }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    expect(response.status).toBe(200);
    // Probe was called with merged credentials
    expect(mockProbeIntegrationCredentials).toHaveBeenCalledWith(
      "odoo",
      expect.objectContaining({ apiKey: "new-secret-key" })
    );
    // DB update was called
    expect(mockUpdateSet).toHaveBeenCalled();
    // clearIntegrationAuthError was called
    expect(mockClearIntegrationAuthError).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1" })
    );
    // Audit log for credentials_updated was written with fields
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.credentials_updated",
        resource: "integration:conn-1",
        detail: expect.objectContaining({
          fields: expect.arrayContaining(["apiKey"]),
        }),
        outcome: "success",
      })
    );
    // ONLY the credentials_updated audit fires for a credentials-only PATCH.
    // We deliberately do NOT emit an additional integration.updated event for
    // the credentials field — that would produce two audit rows per mutation
    // and force CISO filters to deduplicate.
    expect(mockAppendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "integration.updated" })
    );
  });

  it("PATCH with both name AND credentials emits BOTH integration.updated and integration.credentials_updated", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({
          name: "Renamed Odoo",
          credentials: { ...validOdooCredentials, apiKey: "rotated-key" },
        }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    // integration.updated for the name change
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.updated",
        detail: expect.objectContaining({
          changes: expect.objectContaining({ name: { from: "Test Odoo", to: "Renamed Odoo" } }),
        }),
      })
    );
    // The integration.updated diff must NOT include credentials — that gets
    // its own dedicated event so the change types stay separable in the log.
    const updatedCall = mockAppendAuditLog.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === "integration.updated"
    );
    const updatedDetail = (updatedCall?.[0] as { detail: { changes: Record<string, unknown> } })
      .detail;
    expect(updatedDetail.changes).not.toHaveProperty("credentials");

    // Separate integration.credentials_updated event still fires
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "integration.credentials_updated" })
    );
  });

  it("PATCH with bad new credentials returns 400 with reason and writes nothing", async () => {
    mockProbeIntegrationCredentials.mockResolvedValue({
      success: false,
      reason: "Access denied",
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: validOdooCredentials }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Access denied");
    // db.update should NOT have been called
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("PATCH on google connection rejects credentials field", async () => {
    const googleConnection = {
      ...mockOdooConnection,
      id: "conn-google-1",
      type: "google",
    };
    mockSelectWhere.mockResolvedValueOnce([googleConnection]);

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-google-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: { accessToken: "x" } }),
      }),
      { params: Promise.resolve({ connectionId: "conn-google-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Google|OAuth|Reconnect/i);
    // Probe should not have been called
    expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
    // DB update should not have been called
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("PATCH with only name (no credentials) skips probe and updates normally", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "New Name" }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    expect(response.status).toBe(200);
    // Probe should NOT have been called
    expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
    // DB update was still called (for name change)
    expect(mockUpdateSet).toHaveBeenCalled();
    // No credentials_updated audit log
    expect(mockAppendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "integration.credentials_updated" })
    );
  });

  it("persists freshCredentials returned by probe (e.g. new uid after login change)", async () => {
    // When the user changes their Odoo login, the stored uid becomes stale.
    // The probe re-authenticates and returns the fresh uid; the route must
    // merge that into the encrypted credentials so future syncs use it.
    mockProbeIntegrationCredentials.mockResolvedValue({
      success: true,
      freshCredentials: { uid: 99 },
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({
          credentials: { ...validOdooCredentials, login: "new-user", apiKey: "new-key" },
        }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    // encrypt() must have been called with JSON containing the FRESH uid (99),
    // not the stale stored uid (2).
    const encryptedPayload = mockEncrypt.mock.calls[0]?.[0] as string;
    const persistedCreds = JSON.parse(encryptedPayload);
    expect(persistedCreds.uid).toBe(99);
    expect(persistedCreds.login).toBe("new-user");
    expect(persistedCreds.apiKey).toBe("new-key");
  });

  it("returns 409 when credentials were updated concurrently (optimistic lock)", async () => {
    // Simulate concurrent update: db.update returns 0 rows
    mockUpdateSet.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: validOdooCredentials }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/concurrent/i);
    // Probe still ran before the write
    expect(mockProbeIntegrationCredentials).toHaveBeenCalled();
  });
});

describe("PATCH /api/integrations/[connectionId] — MCP credential rotation", () => {
  const mcpConnection = {
    id: "conn-mcp-1",
    type: "mcp",
    name: "GitHub",
    description: "",
    credentials: "encrypted-creds",
    data: {
      type: "mcp",
      preset: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      tools: [{ name: "list_repos", inputSchema: {} }],
      lastSyncAt: "2026-01-01T00:00:00.000Z",
    },
    status: "active",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockSelectWhere.mockResolvedValue([mcpConnection]);
    mockDecrypt.mockReturnValue(JSON.stringify({ token: "ghp_old" }));
    mockEncrypt.mockReturnValue("encrypted-creds");
    mockUpdateSet.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ ...mcpConnection, name: "GitHub" }]),
      }),
    });
  });

  it("rotates an MCP token by re-discovering tools via listMcpTools, never the Odoo probe", async () => {
    mockListMcpTools.mockResolvedValue([
      { name: "list_repos", inputSchema: {} },
      { name: "create_issue", inputSchema: {} },
    ]);

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");
    const response = await PATCH(
      makeRequest("/api/integrations/conn-mcp-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: { token: "ghp_new" } }),
      }),
      { params: Promise.resolve({ connectionId: "conn-mcp-1" }) }
    );

    expect(response.status).toBe(200);
    // Validates the new token against the upstream server using the stored
    // url/transport — the probe registry doesn't know mcp.
    expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
    expect(mockListMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.githubcopilot.com/mcp/",
        transport: "http",
        token: "ghp_new",
      })
    );
    expect(mockUpdateSet).toHaveBeenCalled();
    expect(mockClearIntegrationAuthError).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-mcp-1" })
    );
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.credentials_updated",
        detail: expect.objectContaining({ fields: expect.arrayContaining(["token"]) }),
        outcome: "success",
      })
    );
  });

  it("rejects the rotation with 400 when the new token fails discovery — no write", async () => {
    mockListMcpTools.mockRejectedValue(new Error("MCP server returned 401 Unauthorized"));

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");
    const response = await PATCH(
      makeRequest("/api/integrations/conn-mcp-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: { token: "ghp_bad" } }),
      }),
      { params: Promise.resolve({ connectionId: "conn-mcp-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});
