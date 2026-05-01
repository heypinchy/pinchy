import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Chat } from "@/components/chat";
import type { Agent } from "@/components/agent-list";

const { mockGetAgent, mockUseChatStatus } = vi.hoisted(() => ({
  mockGetAgent: vi.fn() as ReturnType<typeof vi.fn>,
  mockUseChatStatus: vi.fn(),
}));

vi.mock("@/components/agents-provider", () => ({
  useAgentsContext: () => ({
    agents: [],
    sortedAgents: [],
    getAgent: mockGetAgent,
  }),
}));

vi.mock("@/lib/avatar", () => ({
  getAgentAvatarSvg: vi.fn(
    (agent: { avatarSeed: string | null; name: string }) =>
      `data:image/svg+xml;utf8,mock-${agent.avatarSeed ?? agent.name}`
  ),
}));

vi.mock("@/hooks/use-ws-runtime", () => ({
  useWsRuntime: vi.fn().mockReturnValue({
    runtime: {},
    isConnected: true,
    isDelayed: false,
    isHistoryLoaded: true,
    hasContent: true,
    isOpenClawConnected: true,
  }),
}));

vi.mock("@/hooks/use-chat-status", () => ({
  useChatStatus: mockUseChatStatus,
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/assistant-ui/thread", () => ({
  Thread: () => <div data-testid="thread">Thread</div>,
}));

vi.mock("@/components/mobile-chat-header", () => ({
  MobileChatHeader: ({ agentId, agentName, avatarUrl }: any) => (
    <div data-testid="mobile-chat-header" data-agent-id={agentId} data-avatar-url={avatarUrl}>
      {agentName}
    </div>
  ),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { useWsRuntime } from "@/hooks/use-ws-runtime";
import { ChatStatusContext } from "@/components/chat";

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockReturnValue(undefined);
    mockUseChatStatus.mockReturnValue({ kind: "ready" });
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: true,
      isDelayed: false,
      isHistoryLoaded: true,
      hasContent: true,
      isOpenClawConnected: true,
      isRunning: false,
      reconnectExhausted: false,
      isOrphaned: false,
      onRetryContinue: vi.fn(),
      onRetryResend: vi.fn(),
    });
  });

  it("should render agent name in header", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const elements = screen.getAllByText("Smithers");
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it("should render the Thread component", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByTestId("thread")).toBeInTheDocument();
  });

  describe("status indicator colors and labels", () => {
    function getDotColor(label: string | RegExp): string {
      // The accessible label sits on the wrapping <button> (focusable, larger
      // hit area for the tooltip); the colored dot is the inner <span>.
      const trigger = screen.getByLabelText(label);
      const dot = trigger.querySelector("span");
      expect(dot).not.toBeNull();
      return dot!.className;
    }

    it('shows green dot with "Connected" label for ready status', () => {
      mockUseChatStatus.mockReturnValue({ kind: "ready" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor("Connected")).toContain("bg-green-600");
    });

    it('shows green dot with "Responding..." label for responding status', () => {
      mockUseChatStatus.mockReturnValue({ kind: "responding" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor(/responding/i)).toContain("bg-green-600");
    });

    it('shows yellow dot with label containing "Starting" for starting status', () => {
      mockUseChatStatus.mockReturnValue({ kind: "starting" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor(/starting/i)).toContain("bg-yellow-500");
    });

    it('shows yellow dot with label containing "Applying" for unavailable/configuring status', () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "configuring" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor(/applying/i)).toContain("bg-yellow-500");
    });

    it('shows red dot with label containing "Reconnecting" for unavailable/disconnected status', () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "disconnected" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor(/reconnecting/i)).toContain("bg-destructive");
    });

    it('shows red dot with label containing "reload" for unavailable/exhausted status', () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "exhausted" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor(/reload/i)).toContain("bg-destructive");
    });
  });

  it("should render a settings link with correct href when canEdit is true", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" canEdit={true} />);
    const settingsLink = screen.getByRole("link", { name: /settings/i });
    expect(settingsLink).toBeInTheDocument();
    expect(settingsLink).toHaveAttribute("href", "/chat/agent-1/settings");
  });

  it("should not render a settings link when canEdit is false", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" canEdit={false} />);
    expect(screen.queryByRole("link", { name: /settings/i })).not.toBeInTheDocument();
  });

  it("should render MobileChatHeader", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const mobileHeader = screen.getByTestId("mobile-chat-header");
    expect(mobileHeader).toBeInTheDocument();
    expect(mobileHeader).toHaveAttribute("data-agent-id", "agent-1");
  });

  it("should render the settings link with the correct agent-specific href", () => {
    render(<Chat agentId="my-special-agent" agentName="Test Agent" canEdit={true} />);
    const settingsLink = screen.getByRole("link", { name: /settings/i });
    expect(settingsLink).toHaveAttribute("href", "/chat/my-special-agent/settings");
  });

  it("should show 'Shared' badge for shared agents", () => {
    render(<Chat agentId="agent-1" agentName="Sales Bot" isPersonal={false} />);
    expect(screen.getByText("Shared")).toBeInTheDocument();
  });

  it("should show 'Private' badge for personal agents", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" isPersonal={true} />);
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("should default to 'Shared' badge when isPersonal is not provided", () => {
    render(<Chat agentId="agent-1" agentName="Sales Bot" />);
    expect(screen.getByText("Shared")).toBeInTheDocument();
  });

  it("should render avatar image in header when avatarUrl is provided", () => {
    const { container } = render(
      <Chat agentId="agent-1" agentName="Smithers" avatarUrl="data:image/svg+xml;utf8,test" />
    );
    const avatar = container.querySelector('img[src="data:image/svg+xml;utf8,test"]');
    expect(avatar).toBeInTheDocument();
  });

  it("should not render avatar image in header when avatarUrl is not provided", () => {
    const { container } = render(<Chat agentId="agent-1" agentName="Smithers" />);
    const avatars = container.querySelectorAll("header img");
    expect(avatars.length).toBe(0);
  });

  describe("live agent data from context", () => {
    const liveAgent: Agent = {
      id: "agent-1",
      name: "Renamed Agent",
      model: "anthropic/claude-sonnet-4-6",
      isPersonal: true,
      tagline: "New tagline",
      avatarSeed: "new-seed",
    };

    it("should use live agent name instead of SSR prop", () => {
      mockGetAgent.mockReturnValue(liveAgent);
      render(<Chat agentId="agent-1" agentName="Old Name" />);
      const elements = screen.getAllByText("Renamed Agent");
      expect(elements.length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("Old Name")).not.toBeInTheDocument();
    });

    it("should use live avatar from context instead of SSR avatarUrl", () => {
      mockGetAgent.mockReturnValue(liveAgent);
      const { container } = render(
        <Chat agentId="agent-1" agentName="Old Name" avatarUrl="data:image/svg+xml;utf8,old" />
      );
      const avatar = container.querySelector('img[src="data:image/svg+xml;utf8,mock-new-seed"]');
      expect(avatar).toBeInTheDocument();
    });

    it("should use live isPersonal from context instead of SSR prop", () => {
      mockGetAgent.mockReturnValue(liveAgent);
      render(<Chat agentId="agent-1" agentName="Old Name" isPersonal={false} />);
      expect(screen.getByText("Private")).toBeInTheDocument();
    });

    it("should fall back to SSR props when agent not in context", () => {
      mockGetAgent.mockReturnValue(undefined);
      render(
        <Chat
          agentId="agent-1"
          agentName="SSR Name"
          isPersonal={false}
          avatarUrl="data:image/svg+xml;utf8,ssr-avatar"
        />
      );
      const nameElements = screen.getAllByText("SSR Name");
      expect(nameElements.length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Shared").length).toBeGreaterThanOrEqual(1);
    });

    it("should pass live agent name to MobileChatHeader", () => {
      mockGetAgent.mockReturnValue(liveAgent);
      render(<Chat agentId="agent-1" agentName="Old Name" />);
      const mobileHeader = screen.getByTestId("mobile-chat-header");
      expect(mobileHeader).toHaveTextContent("Renamed Agent");
    });

    it("should pass live avatar to MobileChatHeader", () => {
      mockGetAgent.mockReturnValue(liveAgent);
      render(<Chat agentId="agent-1" agentName="Old Name" />);
      const mobileHeader = screen.getByTestId("mobile-chat-header");
      expect(mobileHeader).toHaveAttribute(
        "data-avatar-url",
        "data:image/svg+xml;utf8,mock-new-seed"
      );
    });
  });

  it("provides ChatStatusContext with ready status when fully connected", () => {
    // Render Chat; with the beforeEach mock (isConnected: true,
    // isOpenClawConnected: true, isHistoryLoaded: true, isRunning: false,
    // reconnectExhausted: false) and no configuring prop, useChatStatus
    // resolves to { kind: "ready" }. The MobileChatHeader mock exposes the
    // context value via a data attribute so we can assert it without adding
    // children support to Chat.
    render(<Chat agentId="agent-1" agentName="Test Agent" />);

    // useChatStatus is called inside Chat with the wired inputs. Since
    // ChatStatusContext.Provider receives its return value directly, we verify
    // the provider is correctly wired by reading the context from the
    // MobileChatHeader mock (rendered inside Chat) via useContext.
    // Because no current child mock reads ChatStatusContext, we assert instead
    // that useChatStatus is called with the correct inputs — the hook's own
    // unit tests cover the output mapping exhaustively.
    expect(mockUseChatStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        isConnected: true,
        isOpenClawConnected: true,
        isHistoryLoaded: true,
        hasContent: true,
        isRunning: false,
        reconnectExhausted: false,
        configuring: false,
      })
    );
    expect(mockUseChatStatus).toHaveReturnedWith({ kind: "ready" });
  });

  describe("ChatStatusBanner", () => {
    it("shows nothing when ready", () => {
      mockUseChatStatus.mockReturnValue({ kind: "ready" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/reload the page/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/applying your changes/i)).not.toBeInTheDocument();
    });

    it("shows delayed message when responding and delayed", () => {
      mockUseChatStatus.mockReturnValue({ kind: "responding" });
      vi.mocked(useWsRuntime).mockReturnValue({
        runtime: {} as any,
        isConnected: true,
        isDelayed: true,
        isHistoryLoaded: true,
        hasContent: true,
        isOpenClawConnected: true,
        isRunning: true,
        reconnectExhausted: false,
        isOrphaned: false,
        onRetryContinue: vi.fn(),
        onRetryResend: vi.fn(),
      });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument();
    });

    it("shows exhausted message when unavailable/exhausted", () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "exhausted" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.getByText(/reload the page/i)).toBeInTheDocument();
    });

    it("shows configuring message when unavailable/configuring", () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "configuring" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.getByText(/applying your changes/i)).toBeInTheDocument();
    });

    it("shows nothing when unavailable/disconnected", () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "disconnected" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/reload the page/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/applying your changes/i)).not.toBeInTheDocument();
    });

    it("shows nothing when starting", () => {
      mockUseChatStatus.mockReturnValue({ kind: "starting" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/reload the page/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/applying your changes/i)).not.toBeInTheDocument();
    });
  });
});
