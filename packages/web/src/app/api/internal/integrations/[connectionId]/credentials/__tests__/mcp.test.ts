import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockLimit } = vi.hoisted(() => ({
  mockLimit: vi.fn(),
}));

// ── Static mocks ──────────────────────────────────────────────────────────────

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn().mockReturnValue(JSON.stringify({ token: "mcp-secret-token" })),
  encrypt: vi.fn().mockReturnValue("re-encrypted-blob"),
}));

vi.mock("@/lib/integrations/google-oauth", () => ({
  isTokenExpired: vi.fn().mockReturnValue(false),
  refreshAccessToken: vi.fn(),
}));

vi.mock("@/lib/integrations/oauth-settings", () => ({
  getOAuthSettings: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: mockLimit,
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { decrypt } from "@/lib/encryption";
import { GET } from "@/app/api/internal/integrations/[connectionId]/credentials/route";

// ── Test data ─────────────────────────────────────────────────────────────────

const VALID_CONNECTION_ID = "conn-mcp-creds-1";

const mockMcpConnection = {
  id: VALID_CONNECTION_ID,
  type: "mcp",
  name: "My GitHub MCP",
  status: "active",
  credentials: "encrypted-mcp-creds",
  data: {
    type: "mcp",
    preset: "github",
    transport: "http",
    url: "https://mcp.example.com/github",
    tools: [],
    lastSyncAt: "2026-01-01T00:00:00.000Z",
  },
};

function makeRequest(connectionId: string, token = "valid-gateway-token") {
  return new NextRequest(`http://localhost/api/internal/integrations/${connectionId}/credentials`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

function makeParams(connectionId: string) {
  return { params: Promise.resolve({ connectionId }) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/internal/integrations/:connectionId/credentials (type=mcp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    vi.mocked(decrypt).mockReturnValue(JSON.stringify({ token: "mcp-secret-token" }));
    mockLimit.mockResolvedValue([mockMcpConnection]);
  });

  it("returns decrypted { token } credentials for an active MCP connection", async () => {
    const res = await GET(makeRequest(VALID_CONNECTION_ID), makeParams(VALID_CONNECTION_ID));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.type).toBe("mcp");
    expect(data.credentials).toEqual({ token: "mcp-secret-token" });

    // No extra fields beyond token in MCP credentials
    expect(Object.keys(data.credentials)).toEqual(["token"]);

    // Credentials were decrypted from the encrypted blob
    expect(decrypt).toHaveBeenCalledWith("encrypted-mcp-creds");
  });

  it("returns 401 when Authorization header does not match the gateway token", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await GET(
      makeRequest(VALID_CONNECTION_ID, "wrong-token"),
      makeParams(VALID_CONNECTION_ID)
    );

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns 403 when connection status is pending", async () => {
    mockLimit.mockResolvedValue([
      {
        ...mockMcpConnection,
        status: "pending",
      },
    ]);

    const res = await GET(makeRequest(VALID_CONNECTION_ID), makeParams(VALID_CONNECTION_ID));

    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Connection not active");
  });
});
