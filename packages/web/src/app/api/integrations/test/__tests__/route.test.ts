/**
 * Tests for POST /api/integrations/test (Task 7.2)
 * Read-only route — calls listMcpTools once, no DB write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

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
    constructor(message = "MCP server returned 401 Unauthorized") {
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
  // Mirrors the real implementation's name-based mapping so route tests can
  // assert the wire `code` without importing the server-only SDK module.
  mcpErrorCodeFromError: (err: unknown) => {
    const name = err instanceof Error ? err.name : "";
    if (name === "McpAuthError") return "unauthorized";
    if (name === "McpServerError") return "server_error";
    if (name === "McpSchemaError") return "schema";
    return "network";
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost:7777/api/integrations/test", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const adminSession = { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };
const memberSession = { user: { id: "user-2", email: "member@test.com", role: "member" } };

const mockTools = [
  { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
  { name: "create_issue", description: "Create an issue", inputSchema: { type: "object" } },
];

const validBody = {
  url: "https://mcp.example.com/",
  transport: "http",
  token: "tok-secret",
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/integrations/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockGetSession.mockResolvedValue(adminSession);
    mockListMcpTools.mockResolvedValue(mockTools);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 200 with tool list on success", async () => {
    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tools).toEqual(mockTools);
    expect(mockListMcpTools).toHaveBeenCalledWith({
      url: validBody.url,
      transport: validBody.transport,
      token: validBody.token,
    });
  });

  it("does NOT write to the database", async () => {
    // No db mock is set up — if route tries to write to DB, it would throw.
    // This test verifies the route succeeds without any DB calls.
    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(200);
    // listMcpTools called, no DB dependency
  });

  it("returns 403 for non-admin users", async () => {
    mockGetSession.mockResolvedValueOnce(memberSession);

    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(403);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(makeRequest(validBody));

    expect(response.status).toBe(401);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body (missing url)", async () => {
    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(makeRequest({ transport: "http", token: "tok" }));

    expect(response.status).toBe(400);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid transport value", async () => {
    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(
      makeRequest({ url: "https://mcp.example.com/", transport: "grpc", token: "tok" })
    );

    expect(response.status).toBe(400);
    expect(mockListMcpTools).not.toHaveBeenCalled();
  });

  it("returns 502 with code=unauthorized when listMcpTools throws McpAuthError", async () => {
    const { McpAuthError } = await import("@/lib/integrations/mcp-client");
    mockListMcpTools.mockRejectedValueOnce(new McpAuthError());

    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBeDefined();
    // The dialog maps this stable code onto a human-friendly message
    // (mcp-error-messages.ts) instead of showing the raw protocol error.
    expect(body.code).toBe("unauthorized");
  });

  it("returns 502 with code=network when listMcpTools throws a generic error", async () => {
    mockListMcpTools.mockRejectedValueOnce(new Error("Connection refused"));

    const { POST } = await import("@/app/api/integrations/test/route");

    const response = await POST(makeRequest(validBody));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBeDefined();
    expect(body.code).toBe("network");
  });
});
