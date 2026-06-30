import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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

  it("sets a short private Cache-Control header to absorb navigation (#261)", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: { id: "user-1", role: "admin" },
      expires: "",
    } as never);

    const request = new NextRequest("http://localhost:7777/api/agents");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=5, must-revalidate");
  });
});
