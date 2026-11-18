import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { routeContext } from "@/test-helpers/route";

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/visible-agents", () => ({
  getVisibleAgents: vi.fn().mockResolvedValue([
    {
      id: "a1",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-6",
      isPersonal: false,
      visibility: "all",
      tagline: null,
      starterPrompts: [],
      avatarSeed: null,
    },
  ]),
}));

import { GET } from "@/app/api/agents/route";

describe("GET /api/agents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is never served from the browser cache, so the next user on a shared browser never sees this one's list (#1286)", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-1", role: "admin" },
      expires: "",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents");
    const response = await GET(request, routeContext());

    expect(response.status).toBe(200);
    // The browser keys its cache by URL, not by user: a private max-age handed
    // the previous user's list to whoever signed in next on the same browser.
    // The list lives in AgentsProvider's client state, so the cache bought
    // nothing (#261's navigation case no longer refetches).
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
