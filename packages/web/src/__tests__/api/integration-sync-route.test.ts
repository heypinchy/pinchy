import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockDecrypt = vi.fn();
vi.mock("@/lib/encryption", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockSelectWhere = vi.fn();
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: mockUpdateWhere,
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

const mockFetchOdooSchema = vi.fn();
vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: (...args: unknown[]) => mockFetchOdooSchema(...args),
}));

vi.mock("@/lib/integrations/odoo-schema", () => ({
  odooCredentialsSchema: {
    safeParse: vi.fn().mockReturnValue({
      success: true,
      data: {
        url: "https://odoo.example.com",
        db: "prod",
        login: "admin",
        apiKey: "secret-key",
        uid: 2,
      },
    }),
  },
}));

vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: vi.fn().mockReturnValue({ valid: true }),
}));

const mockClearIntegrationAuthError = vi.fn();
const mockSetIntegrationAuthFailed = vi.fn();
vi.mock("@/lib/integrations/auth-state", () => ({
  clearIntegrationAuthError: (...args: unknown[]) => mockClearIntegrationAuthError(...args),
  setIntegrationAuthFailed: (...args: unknown[]) => mockSetIntegrationAuthFailed(...args),
}));

vi.mock("@/lib/audit-deferred", () => ({
  deferAuditLog: vi.fn(),
}));

import { NextRequest } from "next/server";

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };

const mockConnection = {
  id: "conn-1",
  type: "odoo",
  name: "Test Odoo",
  credentials: "encrypted-creds",
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const decryptedOdooCreds = {
  url: "https://odoo.example.com",
  db: "prod",
  login: "admin",
  apiKey: "secret-key",
  uid: 2,
};

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:7777${path}`, { method: "POST" });
}

describe("POST /api/integrations/[connectionId]/sync — auth state flipping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockDecrypt.mockReturnValue(JSON.stringify(decryptedOdooCreds));
    mockSelectWhere.mockResolvedValue([mockConnection]);
    mockClearIntegrationAuthError.mockResolvedValue(undefined);
    mockSetIntegrationAuthFailed.mockResolvedValue(undefined);
  });

  it("calls clearIntegrationAuthError when fetchOdooSchema returns success", async () => {
    mockFetchOdooSchema.mockResolvedValue({
      success: true,
      models: 5,
      lastSyncAt: "2026-05-11T00:00:00.000Z",
      categories: [],
      data: { models: [], lastSyncAt: "2026-05-11T00:00:00.000Z" },
    });

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockClearIntegrationAuthError).toHaveBeenCalledWith({
      connectionId: "conn-1",
      actor: { type: "user", id: "user-1" },
    });
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
  });

  it("calls setIntegrationAuthFailed when fetchOdooSchema returns failure with isAuthError: true", async () => {
    mockFetchOdooSchema.mockResolvedValue({
      success: false,
      error: "Could not access any Odoo models.",
      isAuthError: true,
    });

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(mockSetIntegrationAuthFailed).toHaveBeenCalledWith({
      connectionId: "conn-1",
      reason: "Could not access any Odoo models.",
      actor: { type: "user", id: "user-1" },
    });
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
  });

  it("does NOT call setIntegrationAuthFailed when fetchOdooSchema returns isAuthError: false", async () => {
    mockFetchOdooSchema.mockResolvedValue({
      success: false,
      error: "Could not access any Odoo models.",
      isAuthError: false,
    });

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
  });

  it("does NOT call setIntegrationAuthFailed when fetchOdooSchema throws (transient error)", async () => {
    mockFetchOdooSchema.mockRejectedValue(new Error("Network timeout"));

    const { POST } = await import("@/app/api/integrations/[connectionId]/sync/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/sync"), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Network timeout");
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
  });
});
