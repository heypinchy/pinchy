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
const mockEncrypt = vi.fn().mockReturnValue("encrypted-creds");
vi.mock("@/lib/encryption", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockSelectWhere = vi.fn();
const mockUpdateSet = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: mockUpdateSet.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
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

const mockProbeIntegrationCredentials = vi.fn();
vi.mock("@/lib/integrations/probe", () => ({
  probeIntegrationCredentials: (...args: unknown[]) => mockProbeIntegrationCredentials(...args),
}));

const mockClearIntegrationAuthError = vi.fn();
const mockSetIntegrationAuthFailed = vi.fn();
vi.mock("@/lib/integrations/auth-state", () => ({
  clearIntegrationAuthError: (...args: unknown[]) => mockClearIntegrationAuthError(...args),
  setIntegrationAuthFailed: (...args: unknown[]) => mockSetIntegrationAuthFailed(...args),
}));

// odoo-node mock (needed because route still imports OdooClient for uid self-heal)
vi.mock("odoo-node", () => {
  function OdooClient() {}
  OdooClient.authenticate = vi.fn().mockResolvedValue(2);
  return { OdooClient };
});

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

function makeRequest(path: string, options?: RequestInit) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

describe("POST /api/integrations/[connectionId]/test — auth state flipping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockDecrypt.mockReturnValue(JSON.stringify(decryptedOdooCreds));
    mockSelectWhere.mockResolvedValue([mockConnection]);
    mockClearIntegrationAuthError.mockResolvedValue(undefined);
    mockSetIntegrationAuthFailed.mockResolvedValue(undefined);
  });

  it("calls clearIntegrationAuthError with connectionId and actor when probe succeeds", async () => {
    mockProbeIntegrationCredentials.mockResolvedValue({ success: true });

    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
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

  it("calls setIntegrationAuthFailed with connectionId, reason, and actor when probe fails", async () => {
    mockProbeIntegrationCredentials.mockResolvedValue({
      success: false,
      reason: "Authentication failed",
    });

    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication failed");
    expect(mockSetIntegrationAuthFailed).toHaveBeenCalledWith({
      connectionId: "conn-1",
      reason: "Authentication failed",
      actor: { type: "user", id: "user-1" },
    });
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
  });
});
