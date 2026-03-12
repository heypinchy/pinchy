import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AgentsProvider, useAgentsContext } from "@/components/agents-provider";
import type { Agent } from "@/components/agent-list";

const { mockUseAgents, mockUsePathname, mockRouterPush, mockToast } = vi.hoisted(() => ({
  mockUseAgents: vi.fn((agents: Agent[]) => agents),
  mockUsePathname: vi.fn().mockReturnValue("/chat/a1"),
  mockRouterPush: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock("@/hooks/use-agents", () => ({
  useAgents: (agents: Agent[]) => mockUseAgents(agents),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("sonner", () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));

const agents: Agent[] = [
  {
    id: "a1",
    name: "Smithers",
    model: "gpt-4",
    isPersonal: true,
    tagline: "Assistant",
    avatarSeed: "seed1",
  },
  { id: "a2", name: "Alpha", model: "gpt-4", isPersonal: false, tagline: null, avatarSeed: null },
  { id: "a3", name: "Beta", model: "gpt-4", isPersonal: false, tagline: null, avatarSeed: "seed3" },
];

function wrapper({ children }: { children: React.ReactNode }) {
  return <AgentsProvider initialAgents={agents}>{children}</AgentsProvider>;
}

describe("AgentsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAgents.mockImplementation((a: Agent[]) => a);
    mockUsePathname.mockReturnValue("/chat/a1");
  });

  it("should render children and provide agents via context", () => {
    function Consumer() {
      const { agents: ctx } = useAgentsContext();
      return <div data-testid="count">{ctx.length}</div>;
    }

    render(
      <AgentsProvider initialAgents={agents}>
        <Consumer />
      </AgentsProvider>
    );

    expect(screen.getByTestId("count")).toHaveTextContent("3");
  });

  it("should provide getAgent lookup", () => {
    const { result } = renderHook(() => useAgentsContext(), { wrapper });

    expect(result.current.getAgent("a2")).toEqual(agents[1]);
    expect(result.current.getAgent("nonexistent")).toBeUndefined();
  });

  it("should provide sortedAgents (personal first, then alphabetical)", () => {
    const { result } = renderHook(() => useAgentsContext(), { wrapper });

    const sorted = result.current.sortedAgents;
    expect(sorted[0].id).toBe("a1"); // Smithers (personal)
    expect(sorted[1].id).toBe("a2"); // Alpha (alphabetical)
    expect(sorted[2].id).toBe("a3"); // Beta (alphabetical)
  });

  describe("access guard", () => {
    it("should redirect and toast when current agent disappears", () => {
      mockUsePathname.mockReturnValue("/chat/a3");
      // useAgents returns list without a3
      mockUseAgents.mockReturnValue([agents[0], agents[1]]);

      render(
        <AgentsProvider initialAgents={agents}>
          <div>child</div>
        </AgentsProvider>
      );

      expect(mockToast).toHaveBeenCalledWith("You no longer have access to this agent", {
        id: "agent-access-lost",
      });
      // Redirect to sortedAgents[0] = Smithers (personal, first)
      expect(mockRouterPush).toHaveBeenCalledWith("/chat/a1");
    });

    it("should not redirect when current agent is still visible", () => {
      mockUsePathname.mockReturnValue("/chat/a1");
      mockUseAgents.mockReturnValue(agents);

      render(
        <AgentsProvider initialAgents={agents}>
          <div>child</div>
        </AgentsProvider>
      );

      expect(mockToast).not.toHaveBeenCalled();
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it("should not redirect when not on a chat page", () => {
      mockUsePathname.mockReturnValue("/settings");
      mockUseAgents.mockReturnValue([]);

      render(
        <AgentsProvider initialAgents={agents}>
          <div>child</div>
        </AgentsProvider>
      );

      expect(mockToast).not.toHaveBeenCalled();
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it("should redirect to first sorted agent (personal first)", () => {
      mockUsePathname.mockReturnValue("/chat/a3");
      // Only non-personal agents left
      const nonPersonal: Agent[] = [
        {
          id: "a3-zeta",
          name: "Zeta",
          model: "gpt-4",
          isPersonal: false,
          tagline: null,
          avatarSeed: null,
        },
        {
          id: "a3-alpha",
          name: "Alpha",
          model: "gpt-4",
          isPersonal: false,
          tagline: null,
          avatarSeed: null,
        },
      ];
      mockUseAgents.mockReturnValue(nonPersonal);

      render(
        <AgentsProvider initialAgents={agents}>
          <div>child</div>
        </AgentsProvider>
      );

      // Should redirect to Alpha (alphabetically first)
      expect(mockRouterPush).toHaveBeenCalledWith("/chat/a3-alpha");
    });

    it("should not redirect when agent list is empty", () => {
      mockUsePathname.mockReturnValue("/chat/a1");
      mockUseAgents.mockReturnValue([]);

      render(
        <AgentsProvider initialAgents={agents}>
          <div>child</div>
        </AgentsProvider>
      );

      expect(mockRouterPush).not.toHaveBeenCalled();
    });
  });
});
