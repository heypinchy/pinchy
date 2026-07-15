import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockListMcpTools = vi.fn();
vi.mock("@/lib/integrations/mcp-client", () => ({
  listMcpTools: (...args: unknown[]) => mockListMcpTools(...args),
  McpAuthError: class McpAuthError extends Error {
    constructor(message = "MCP server rejected the token") {
      super(message);
      this.name = "McpAuthError";
    }
  },
  McpServerError: class McpServerError extends Error {
    readonly statusCode: number;
    readonly body: string;
    constructor(statusCode: number, body: string) {
      super(`MCP server returned ${statusCode}: ${body}`);
      this.name = "McpServerError";
      this.statusCode = statusCode;
      this.body = body;
    }
  },
  McpSchemaError: class McpSchemaError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "McpSchemaError";
    }
  },
  mcpErrorCodeFromError: (err: unknown) => {
    const name = err instanceof Error ? err.name : "";
    if (name === "McpAuthError") return "unauthorized";
    if (name === "McpServerError") return "server_error";
    if (name === "McpSchemaError") return "schema";
    return "network";
  },
}));

function makeRequest(path: string, options?: RequestInit) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

const adminSession = { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };
const memberSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const validMcpBody = {
  type: "mcp",
  transport: "http",
  url: "https://mcp.example.com/github",
  token: "mcp-token-123",
};

const mockTools = [
  { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
];

describe("POST /api/integrations/test-credentials (type=mcp)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockGetSession.mockResolvedValue(adminSession);
    mockListMcpTools.mockResolvedValue(mockTools);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns discovered tools on success — no state is persisted", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListMcpTools).toHaveBeenCalledWith({
      url: validMcpBody.url,
      transport: validMcpBody.transport,
      token: validMcpBody.token,
      extraHeaders: undefined,
    });
    expect(body.success).toBe(true);
    expect(body.tools).toEqual(mockTools);
  });

  it("forwards extraHeaders (e.g. HighLevel's locationId) to discovery", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");

    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify({ ...validMcpBody, extraHeaders: { locationId: "loc-123" } }),
    });
    await POST(request);

    expect(mockListMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({ extraHeaders: { locationId: "loc-123" } })
    );
  });

  it("returns success:false with a wire code when discovery fails (401)", async () => {
    const { McpAuthError } = await import("@/lib/integrations/mcp-client");
    mockListMcpTools.mockRejectedValueOnce(new McpAuthError());

    const { POST } = await import("@/app/api/integrations/test-credentials/route");
    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.code).toBe("unauthorized");
  });

  it("returns success:false with code=server_error on a 5xx", async () => {
    const { McpServerError } = await import("@/lib/integrations/mcp-client");
    mockListMcpTools.mockRejectedValueOnce(new McpServerError(503, "unavailable"));

    const { POST } = await import("@/app/api/integrations/test-credentials/route");
    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.code).toBe("server_error");
  });

  it("returns 400 for an invalid url", async () => {
    const { POST } = await import("@/app/api/integrations/test-credentials/route");
    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify({ ...validMcpBody, url: "not-a-url" }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("returns 404 when PINCHY_MCP_ENABLED is not set", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", undefined);
    const { POST } = await import("@/app/api/integrations/test-credentials/route");
    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(404);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/integrations/test-credentials/route");
    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-admin users and never calls listMcpTools", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);
    const { POST } = await import("@/app/api/integrations/test-credentials/route");
    const request = makeRequest("/api/integrations/test-credentials", {
      method: "POST",
      body: JSON.stringify(validMcpBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });
});
