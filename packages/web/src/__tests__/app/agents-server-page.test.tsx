import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/require-auth", () => ({
  requireAuth: vi.fn(),
}));

const mockHeadersGet = vi.fn();
vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({
    get: (...args: unknown[]) => mockHeadersGet(...args),
  }),
}));

const mockDbSelect = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  activeAgents: { id: "id", isPersonal: "isPersonal", ownerId: "ownerId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ op: "eq", val })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
}));

const mockGetVisibleAgents = vi.fn();
vi.mock("@/lib/visible-agents", () => ({
  getVisibleAgents: (...args: unknown[]) => mockGetVisibleAgents(...args),
}));

vi.mock("@/lib/groups", () => ({
  getUserGroupIds: vi.fn().mockResolvedValue([]),
  getAgentGroupIds: vi.fn().mockResolvedValue([]),
  getAllAgentGroupIds: vi.fn().mockResolvedValue(new Map()),
}));

import { requireAuth } from "@/lib/require-auth";
import AgentsPage from "@/app/(app)/agents/page";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;

describe("AgentsPage (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });
    mockGetVisibleAgents.mockResolvedValue([
      { id: "visible-agent", isPersonal: true, ownerId: "user-1", visibility: "all" },
    ]);
  });

  it("redirects to first visible agent on desktop", async () => {
    mockHeadersGet.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    );

    await expect(AgentsPage()).rejects.toThrow("REDIRECT:/chat/visible-agent");
  });

  it("does not redirect on mobile (renders page)", async () => {
    mockHeadersGet.mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    );

    const result = await AgentsPage();
    expect(result).toBeDefined();
  });

  it("redirects to first visible agent, not first DB agent", async () => {
    mockGetVisibleAgents.mockResolvedValue([
      { id: "my-smithers", isPersonal: true, ownerId: "user-1", visibility: "all" },
    ]);
    mockHeadersGet.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    );

    await expect(AgentsPage()).rejects.toThrow("REDIRECT:/chat/my-smithers");
  });
});
