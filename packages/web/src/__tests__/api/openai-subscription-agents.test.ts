import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "admin" } }),
}));
vi.mock("@/lib/agents", () => ({
  getAgentsUsingOpenAiProvider: vi.fn(),
}));

import { GET } from "@/app/api/providers/openai/subscription/agents/route";
import * as agentsLib from "@/lib/agents";
import { requireAdmin } from "@/lib/api-auth";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/providers/openai/subscription/agents", () => {
  it("returns list of agents using OpenAI provider", async () => {
    vi.mocked(agentsLib.getAgentsUsingOpenAiProvider).mockResolvedValue([
      { id: "a1", name: "GPT Agent" },
      { id: "a2", name: "Codex Agent" },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: "a1", name: "GPT Agent" },
      { id: "a2", name: "Codex Agent" },
    ]);
  });

  it("returns empty array when no agents use OpenAI", async () => {
    vi.mocked(agentsLib.getAgentsUsingOpenAiProvider).mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns 401 when not authenticated as admin", async () => {
    const { NextResponse } = await import("next/server");
    vi.mocked(requireAdmin).mockResolvedValueOnce(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never
    );

    const res = await GET();

    expect(res.status).toBe(401);
  });
});
