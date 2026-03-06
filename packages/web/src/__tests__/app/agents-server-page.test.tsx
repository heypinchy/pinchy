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

import { requireAuth } from "@/lib/require-auth";
import AgentsPage from "@/app/(app)/agents/page";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;

function setupAgentsQuery(agents: Array<{ id: string }>) {
  const whereMock = vi.fn().mockResolvedValue(agents);
  const limitMock = vi.fn().mockResolvedValue(agents.slice(0, 1));
  const fromMock = vi.fn().mockReturnValue({ where: whereMock, limit: limitMock });
  mockDbSelect.mockReturnValue({ from: fromMock });
}

describe("AgentsPage (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAuth.mockResolvedValue({
      user: { id: "user-1", role: "user" },
    });
    setupAgentsQuery([{ id: "agent-1" }]);
  });

  it("redirects to first agent chat on desktop", async () => {
    mockHeadersGet.mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    );

    await expect(AgentsPage()).rejects.toThrow("REDIRECT:/chat/agent-1");
  });

  it("does not redirect on mobile (renders page)", async () => {
    mockHeadersGet.mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
    );

    // Should NOT throw a redirect — it renders the page
    const result = await AgentsPage();
    expect(result).toBeDefined();
  });
});
