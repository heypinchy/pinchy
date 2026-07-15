import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/agents — key-authenticated agent listing (#572, Task 4.1).
 *
 * Unlike the session `GET /api/agents` (which filters via `getVisibleAgents`),
 * this route is org-scoped: no per-user visibility filtering (design D4). It
 * delegates that — and the exclusion of personal agents — to
 * `listAgents({ scope: "shared" })`, whose behavior is proven against a real
 * database in lib/list-agents-service.integration.test.ts. Here `listAgents`
 * is mocked, so the only thing this suite can prove about scoping is that the
 * route ASKS for the right scope; the assertion below is deliberately exact
 * about that literal, because passing "all" is precisely the regression that
 * would re-expose personal agents.
 */

const { mockVerifyApiKey } = vi.hoisted(() => ({
  mockVerifyApiKey: vi.fn(),
}));

// `route.ts` imports `withApiKey` from `@/lib/api-auth`, which itself imports
// both `getSession` (session wrappers) and `auth` (→ `auth.api.verifyApiKey`)
// from `@/lib/auth`. The factory must export both so importing the module
// never yields `undefined` — mirrors `with-api-key.test.ts`.
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
    listAgents: vi.fn(),
    createAgent: vi.fn(),
  };
});

import { GET } from "@/app/api/v1/agents/route";
import { listAgents } from "@/lib/agents";

function reqWith(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/agents", { headers });
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

describe("GET /api/v1/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with the org's shared agents for a valid agents:read key", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey());
    const agents = [
      { id: "a1", name: "Smithers", model: "anthropic/claude-sonnet-4-6" },
      { id: "a2", name: "Knowledge Base", model: "anthropic/claude-haiku-4-5-20251001" },
    ];
    vi.mocked(listAgents).mockResolvedValueOnce(agents as never);

    const response = await GET(reqWith({ Authorization: "Bearer pinchy_good" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agents });
    // Exact literal, not objectContaining: "shared" is what excludes personal
    // agents. A regression to "all" would hand a machine credential every
    // user's private agent, and this is the assertion that stops it.
    expect(listAgents).toHaveBeenCalledWith({ scope: "shared" });
  });

  it("returns 403 Forbidden when the key is missing the agents:read scope", async () => {
    mockVerifyApiKey.mockResolvedValue(verifiedKey({ permissions: { agents: ["write"] } }));

    const response = await GET(reqWith({ Authorization: "Bearer pinchy_write_only" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("returns 401 Unauthorized when no API key is present", async () => {
    const response = await GET(reqWith());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(listAgents).not.toHaveBeenCalled();
  });
});
