// @vitest-environment jsdom
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

const { mockGetInstancePolicy } = vi.hoisted(() => ({ mockGetInstancePolicy: vi.fn() }));
vi.mock("@/lib/instance-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-policy")>()),
  getInstancePolicy: mockGetInstancePolicy,
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
    mockGetInstancePolicy.mockResolvedValue({
      memberPersonalAgents: true,
      memberAutomations: true,
    });
  });

  describe("while members may not use a personal agent", () => {
    const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

    beforeEach(() => {
      mockGetInstancePolicy.mockResolvedValue({
        memberPersonalAgents: false,
        memberAutomations: true,
      });
      mockGetVisibleAgents.mockResolvedValue([
        { id: "shared-agent", isPersonal: false, ownerId: null, visibility: "all" },
      ]);
      mockHeadersGet.mockReturnValue(desktop);
    });

    it("stays on the page for a member and tells them why Smithers is gone", async () => {
      // A paused owner is sent here from their Smithers' chat URL; jumping
      // straight on to a shared agent would leave the vanished agent unexplained.
      const result = (await AgentsPage()) as { props: { personalAgentsOff?: boolean } };
      expect(result.props.personalAgentsOff).toBe(true);
    });

    it("still redirects an admin, whose Smithers is unaffected", async () => {
      mockRequireAuth.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
      await expect(AgentsPage()).rejects.toThrow("REDIRECT:/chat/shared-agent");
      expect(mockGetInstancePolicy).not.toHaveBeenCalled();
    });
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
