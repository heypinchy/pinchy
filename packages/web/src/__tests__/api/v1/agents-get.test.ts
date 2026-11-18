import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/agents/[agentId] — key-authenticated single-agent fetch (#572,
 * Task 4.3).
 *
 * Mirrors `agents-list.test.ts`: the route is org-scoped — no per-user
 * visibility filtering (design D4) — and reads via
 * `getAgent(id, { scope: "shared" })`, which also excludes personal agents.
 * `getAgent` is mocked here, so this suite proves the route asks for the right
 * scope and maps the result onto the right status; that the scope actually
 * hides personal agents is proven against a real database in
 * lib/list-agents-service.integration.test.ts. Read-only: no audit entry.
 */

const { mockVerifyApiKey } = vi.hoisted(() => ({
  mockVerifyApiKey: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
  auth: {
    api: {
      verifyApiKey: mockVerifyApiKey,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents")>();
  return {
    ...actual,
    getAgent: vi.fn(),
    deleteAgent: vi.fn(),
  };
});

import { GET } from "@/app/api/v1/agents/[agentId]/route";
import { getAgent } from "@/lib/agents";

// ── Helpers ─────────────────────────────────────────────────────────────

function reqWith(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents/agent-1", { headers });
}

function ctx(agentId = "agent-1") {
  return { params: Promise.resolve({ agentId }) };
}

/** A successful verifyApiKey result with overridable `key` fields. */
function verifiedKey(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    error: null,
    key: {
      id: "key-1",
      name: "Provisioning Key",
      referenceId: "user-1",
      permissions: { agents: ["read"] },
      ...overrides,
    },
  };
}

const mockAgent = {
  id: "agent-1",
  name: "Smithers",
  model: "anthropic/claude-sonnet-4-6",
  isPersonal: false,
};

describe("GET /api/v1/agents/[agentId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with the agent for a valid agents:read key and existing id", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(mockAgent as never);

    const response = await GET(reqWith({ Authorization: "Bearer pinchy_good" }), ctx("agent-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(mockAgent);
    // Exact literal, not objectContaining: "shared" is what excludes personal
    // agents. A regression to "all" would expose every user's private agent
    // to a machine credential, and this is the assertion that stops it.
    expect(getAgent).toHaveBeenCalledWith("agent-1", { scope: "shared" });
  });

  it("returns 404 when the agent does not exist", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    vi.mocked(getAgent).mockResolvedValueOnce(undefined);

    const response = await GET(
      reqWith({ Authorization: "Bearer pinchy_good" }),
      ctx("nonexistent")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found" });
  });

  it("404s a personal agent with the identical body as a nonexistent one — no existence oracle", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    // What `scope: "shared"` hands back for a personal agent: undefined —
    // indistinguishable from "no such id". The route must not develop a
    // separate branch (a 403, or a different message) that would let a key
    // holder probe which ids are users' personal agents.
    vi.mocked(getAgent).mockResolvedValueOnce(undefined);

    const response = await GET(
      reqWith({ Authorization: "Bearer pinchy_good" }),
      ctx("someones-personal-agent")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found" });
  });

  it("returns 403 Forbidden when the key is missing the agents:read scope", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey({ permissions: { agents: ["write"] } }));

    const response = await GET(
      reqWith({ Authorization: "Bearer pinchy_write_only" }),
      ctx("agent-1")
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("returns 401 Unauthorized when no API key is present", async () => {
    const response = await GET(reqWith(), ctx("agent-1"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
  });
});
