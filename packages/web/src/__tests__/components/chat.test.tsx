// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { Chat } from "@/components/chat";
import { makeAgent } from "@/test-helpers/fixtures";
import { clearChatConnection, publishChatConnection } from "@/lib/chat-connection-store";

const {
  mockGetAgent,
  mockUseChatStatus,
  mockUseChatSession,
  mockRecordLastChat,
  mockUsePendingApprovals,
} = vi.hoisted(() => ({
  mockGetAgent: vi.fn() as ReturnType<typeof vi.fn>,
  mockUseChatStatus: vi.fn(),
  mockUseChatSession: vi.fn(),
  mockRecordLastChat: vi.fn(),
  mockUsePendingApprovals: vi.fn(),
}));

vi.mock("@/hooks/use-pending-approvals", () => ({
  usePendingApprovals: mockUsePendingApprovals,
}));

function pendingApprovalFor(agentId: string, chatId?: string) {
  return {
    id: `approval-${agentId}-${chatId ?? "default"}`,
    agentId,
    agentName: "Scout",
    toolName: "odoo_write",
    argsSummary: {},
    // OpenClaw lowercases session keys.
    sessionKey: `agent:${agentId}:direct:user-1${chatId ? `:${chatId}` : ""}`.toLowerCase(),
    createdAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-05T10:15:00.000Z",
  };
}

vi.mock("@/lib/last-chat-store", () => ({
  recordLastChat: (...args: unknown[]) => mockRecordLastChat(...args),
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

vi.mock("@/components/chat-session-provider", () => ({
  useChatSession: mockUseChatSession,
  chatSessionKey: (agentId: string, chatId?: string) => (chatId ? `${agentId}:${chatId}` : agentId),
  // ChatSwitcher (rendered in the header) reads run-state via this hook to
  // refresh the chat title when a run completes; idle in these tests.
  useChatSessionIsRunning: () => false,
  // ChatErrorBanner reads this to suppress itself when the thread already shows
  // the inline error (#583); no inline error in these tests.
  useChatSessionHasInlineError: () => false,
}));

vi.mock("@/hooks/use-chat-status", () => ({
  useChatStatus: mockUseChatStatus,
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/assistant-ui/thread", () => ({
  Thread: () => (
    <div data-testid="thread">
      Thread
      <textarea aria-label="draft" />
    </div>
  ),
}));

vi.mock("@/components/mobile-chat-header", () => ({
  MobileChatHeader: ({ agentId, agentName, avatarUrl, searchesKnowledge }: any) => (
    <div
      data-testid="mobile-chat-header"
      data-agent-id={agentId}
      data-avatar-url={avatarUrl}
      data-searches-knowledge={String(Boolean(searchesKnowledge))}
    >
      {agentName}
    </div>
  ),
}));

vi.mock("@/components/knowledge-search-sheet", () => ({
  KnowledgeSearchSheet: ({ agentId }: any) => (
    <button type="button" data-testid="knowledge-search" data-agent-id={agentId}>
      What can this agent search?
    </button>
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

// The desktop header now renders <ChatSwitcher>, which uses the app router and
// fetches the chat list. Stub both so Chat renders in isolation (with no other
// chats, the switcher falls back to the agent name in its trigger).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/chat/agent-1",
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiGet: vi.fn().mockResolvedValue({ chats: [] }) };
});

const DEFAULT_BUNDLE = {
  runtime: {} as any,
  isConnected: true,
  isDelayed: false,
  isHistoryLoaded: true,
  isReconcilingMessages: false,
  hasInitialContent: true,
  isOpenClawConnected: true,
  isRunning: false,
  reconnectExhausted: false,
  payloadRejected: false,
  onRetryContinue: vi.fn(),
  onRetryResend: vi.fn(),
  lastError: null,
};

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockReturnValue(undefined);
    mockUsePendingApprovals.mockReturnValue({
      approvals: [],
      openId: null,
      open: vi.fn(),
      busy: null,
      decide: vi.fn(),
    });
    mockUseChatStatus.mockReturnValue({ kind: "ready" });
    mockUseChatSession.mockReturnValue({
      bundle: DEFAULT_BUNDLE,
      publish: vi.fn(),
      remove: vi.fn(),
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

  it("passes the chatId through to useChatSession (#508)", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" chatId="chat-x" />);
    expect(mockUseChatSession).toHaveBeenCalledWith("agent-1", "chat-x");
  });

  it("calls useChatSession without a chatId for the legacy/default chat", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(mockUseChatSession).toHaveBeenCalledWith("agent-1", undefined);
  });

  it("records the viewed chat as last-opened for this agent (#508)", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" chatId="chat-x" />);
    expect(mockRecordLastChat).toHaveBeenCalledWith("agent-1", "chat-x");
  });

  it("records the default chat (no chatId) so the last-chat pointer is cleared (#508)", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(mockRecordLastChat).toHaveBeenCalledWith("agent-1", undefined);
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

    it.each([
      ["offline", /offline/i],
      ["rejected", /too many/i],
      ["upstreamDown", /agent isn't reachable/i],
      ["unreachable", /can't reach/i],
    ])("shows red dot for unavailable/%s status", (reason, label) => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor(label)).toContain("bg-destructive");
    });

    it('shows red dot with label containing "Image too large" for payloadRejected status', () => {
      mockUseChatStatus.mockReturnValue({ kind: "payloadRejected" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(getDotColor(/image too large/i)).toContain("bg-destructive");
    });

    // The cold-start E2E guard watches for a red flash during startup. It must
    // see every red state, not only the one whose label it once matched.
    it.each([
      [{ kind: "unavailable", reason: "disconnected" }, "true"],
      [{ kind: "unavailable", reason: "upstreamDown" }, "true"],
      [{ kind: "unavailable", reason: "unreachable" }, "true"],
      [{ kind: "unavailable", reason: "historyTimeout" }, "true"],
      [{ kind: "payloadRejected" }, "true"],
      [{ kind: "starting" }, "false"],
      [{ kind: "unavailable", reason: "configuring" }, "false"],
      [{ kind: "ready" }, "false"],
    ])("marks the indicator for %o with data-error=%s", (status, expected) => {
      mockUseChatStatus.mockReturnValue(status);
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      const button = document.querySelector("button[data-error]");
      expect(button?.getAttribute("data-error")).toBe(expected);
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

  it("offers 'What can this agent search?' on both headers only for a knowledge-base agent", () => {
    const { unmount } = render(<Chat agentId="agent-1" agentName="Smithers" searchesKnowledge />);
    expect(screen.getByTestId("knowledge-search")).toHaveAttribute("data-agent-id", "agent-1");
    expect(screen.getByTestId("mobile-chat-header")).toHaveAttribute(
      "data-searches-knowledge",
      "true"
    );
    unmount();

    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.queryByTestId("knowledge-search")).not.toBeInTheDocument();
    expect(screen.getByTestId("mobile-chat-header")).toHaveAttribute(
      "data-searches-knowledge",
      "false"
    );
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

  describe("Shared badge tooltip", () => {
    // Memory is a per-agent permission (`pinchy_memory`). Only an agent that
    // holds it turns conversations into shared knowledge (#1275).
    async function hoverSharedBadge() {
      await userEvent.hover(screen.getByText("Shared"));
    }

    it("says conversations build team knowledge when the agent has memory", async () => {
      mockGetAgent.mockReturnValue(makeAgent({ allowedTools: ["pinchy_memory"] }));
      render(<Chat agentId="agent-1" agentName="Sales Bot" />);
      await hoverSharedBadge();
      expect((await screen.findAllByText(/help build team knowledge/i)).length).toBeGreaterThan(0);
    });

    it("does not claim team knowledge when the agent has no memory", async () => {
      mockGetAgent.mockReturnValue(makeAgent({ allowedTools: ["knowledge_search"] }));
      render(<Chat agentId="agent-1" agentName="Sales Bot" />);
      await hoverSharedBadge();
      // Only memory is off: files in the shared workspace still persist, so the
      // tooltip must not claim that nothing carries over.
      expect(
        (await screen.findAllByText(/doesn't keep memory of your conversations/i)).length
      ).toBeGreaterThan(0);
      expect(screen.queryByText(/nothing carries over/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/team knowledge/i)).not.toBeInTheDocument();
    });
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
    expect(avatar).toHaveClass("size-10");
  });

  it("should not render avatar image in header when avatarUrl is not provided", () => {
    const { container } = render(<Chat agentId="agent-1" agentName="Smithers" />);
    const avatars = container.querySelectorAll("header img");
    expect(avatars.length).toBe(0);
  });

  describe("live agent data from context", () => {
    const liveAgent = makeAgent({
      id: "agent-1",
      name: "Renamed Agent",
      model: "anthropic/claude-sonnet-4-6",
      isPersonal: true,
      tagline: "New tagline",
      avatarSeed: "new-seed",
    });

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
    // Render Chat; with the beforeEach mock bundle (isConnected: true,
    // isOpenClawConnected: true, isHistoryLoaded: true, isRunning: false,
    // reconnectExhausted: false) and no configuring prop, useChatStatus
    // resolves to { kind: "ready" }.
    render(<Chat agentId="agent-1" agentName="Test Agent" />);

    // useChatStatus is called inside Chat with the wired inputs from the
    // ChatSessionProvider bundle. The hook's own unit tests cover the output
    // mapping exhaustively; here we verify that Chat passes the correct fields.
    expect(mockUseChatStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        isConnected: true,
        isOpenClawConnected: true,
        isHistoryLoaded: true,
        hasInitialContent: true,
        isRunning: false,
        isOffline: false,
        connectionRejection: null,
        payloadRejected: false,
        configuring: false,
      })
    );
    expect(mockUseChatStatus).toHaveReturnedWith({ kind: "ready" });
  });

  it("shows the shared-agent upload hint for non-personal agents", () => {
    mockUseChatStatus.mockReturnValue({ kind: "ready" });
    render(<Chat agentId="agent-shared" agentName="Team Bot" isPersonal={false} />);
    expect(screen.getByText(/visible to anyone with access to this agent/i)).toBeInTheDocument();
  });

  it("hides the shared-agent upload hint for personal agents", () => {
    mockUseChatStatus.mockReturnValue({ kind: "ready" });
    render(<Chat agentId="agent-personal" agentName="Smithers" isPersonal={true} />);
    expect(screen.queryByText(/visible to anyone with access to this agent/i)).toBeNull();
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
      mockUseChatSession.mockReturnValue({
        bundle: {
          ...DEFAULT_BUNDLE,
          isDelayed: true,
          isRunning: true,
        },
        publish: vi.fn(),
        remove: vi.fn(),
      });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument();
    });

    describe("while the agent waits for the user's confirmation (#1301)", () => {
      function delayedResponding() {
        mockUseChatStatus.mockReturnValue({ kind: "responding" });
        mockUseChatSession.mockReturnValue({
          bundle: { ...DEFAULT_BUNDLE, isDelayed: true, isRunning: true },
          publish: vi.fn(),
          remove: vi.fn(),
        });
      }

      it("says it is waiting for the confirmation, not that the agent is slow", () => {
        delayedResponding();
        mockUsePendingApprovals.mockReturnValue({
          approvals: [pendingApprovalFor("agent-1")],
          openId: null,
          open: vi.fn(),
          busy: null,
          decide: vi.fn(),
        });
        render(<Chat agentId="agent-1" agentName="Smithers" />);
        expect(screen.getByText(/waiting for your confirmation/i)).toBeInTheDocument();
        expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument();
      });

      it.each([
        ["another chat with this agent", "agent-1", "chat-b", undefined],
        ["the default chat, from a named one", "agent-1", undefined, "chat-a"],
      ])(
        "still shows the delay hint when the confirmation waits in %s",
        (_label, approvalAgent, approvalChat, openChat) => {
          // A confirmation stalls only the run of its own session; approving it
          // does nothing for this chat's run (#508 per-chat sessions).
          delayedResponding();
          mockUsePendingApprovals.mockReturnValue({
            approvals: [pendingApprovalFor(approvalAgent, approvalChat)],
            openId: null,
            open: vi.fn(),
            busy: null,
            decide: vi.fn(),
          });
          render(<Chat agentId="agent-1" agentName="Smithers" chatId={openChat} />);
          expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument();
          expect(screen.queryByText(/waiting for your confirmation/i)).not.toBeInTheDocument();
        }
      );

      it("says it is waiting when the confirmation waits in this named chat", () => {
        delayedResponding();
        mockUsePendingApprovals.mockReturnValue({
          approvals: [pendingApprovalFor("agent-1", "chat-a")],
          openId: null,
          open: vi.fn(),
          busy: null,
          decide: vi.fn(),
        });
        render(<Chat agentId="agent-1" agentName="Smithers" chatId="chat-a" />);
        expect(screen.getByText(/waiting for your confirmation/i)).toBeInTheDocument();
      });

      it("still shows the delay hint when only another agent waits for a confirmation", () => {
        delayedResponding();
        mockUsePendingApprovals.mockReturnValue({
          approvals: [pendingApprovalFor("agent-2")],
          openId: null,
          open: vi.fn(),
          busy: null,
          decide: vi.fn(),
        });
        render(<Chat agentId="agent-1" agentName="Smithers" />);
        expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument();
        expect(screen.queryByText(/waiting for your confirmation/i)).not.toBeInTheDocument();
      });
    });

    it("offers Try again and Reload once the connection stays unreachable", () => {
      mockUseChatStatus.mockReturnValue({
        kind: "unavailable",
        reason: "unreachable",
        escalated: true,
      });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.getByText(/still trying/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^try again$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^reload$/i })).toBeInTheDocument();
    });

    it("shows configuring message when unavailable/configuring", () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "configuring" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.getByText(/applying your changes/i)).toBeInTheDocument();
    });

    it("says it is still retrying, with no reload prompt, when unavailable/disconnected", () => {
      mockUseChatStatus.mockReturnValue({ kind: "unavailable", reason: "disconnected" });
      render(<Chat agentId="agent-1" agentName="Smithers" />);
      expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/i);
      expect(screen.queryByRole("button", { name: /^reload$/i })).not.toBeInTheDocument();
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

describe("connection status banner (#1422)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearChatConnection("agent-1");
    mockGetAgent.mockReturnValue(undefined);
    mockUsePendingApprovals.mockReturnValue({
      approvals: [],
      openId: null,
      open: vi.fn(),
      busy: null,
      decide: vi.fn(),
    });
  });

  function renderWith(
    status: object,
    rejection: "too_many_connections" | "rate_limited" | null = null
  ) {
    mockUseChatStatus.mockReturnValue(status);
    const retryHistory = vi.fn();
    mockUseChatSession.mockReturnValue({
      bundle: { ...DEFAULT_BUNDLE, retryHistory },
      publish: vi.fn(),
      remove: vi.fn(),
    });
    publishChatConnection("agent-1", undefined, { isOffline: false, rejection });
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    return { retryHistory };
  }

  it("is one polite live region", () => {
    renderWith({ kind: "unavailable", reason: "disconnected" });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the live region in the DOM while nothing is wrong", () => {
    renderWith({ kind: "ready" });
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("offers Try again now while reconnecting and reconnects on click", async () => {
    const { retryHistory } = renderWith({ kind: "unavailable", reason: "disconnected" });
    await userEvent.click(screen.getByRole("button", { name: /try again now/i }));
    expect(retryHistory).toHaveBeenCalledTimes(1);
  });

  it("says we are offline and will reconnect on our own", () => {
    renderWith({ kind: "unavailable", reason: "offline" });
    expect(screen.getByRole("status")).toHaveTextContent(/you're offline/i);
    expect(screen.getByRole("status")).toHaveTextContent(/as soon as you're back/i);
  });

  it("names the connection limit when the server refused with too_many_connections", () => {
    renderWith({ kind: "unavailable", reason: "rejected" }, "too_many_connections");
    expect(screen.getByRole("status")).toHaveTextContent(/too many open connections/i);
    expect(screen.getByRole("status")).toHaveTextContent(/still trying/i);
  });

  it("names the rate limit when the server refused with rate_limited", () => {
    renderWith({ kind: "unavailable", reason: "rejected" }, "rate_limited");
    expect(screen.getByRole("status")).toHaveTextContent(/connecting too quickly/i);
  });

  it("distinguishes a down agent runtime from a configuring one", () => {
    renderWith({ kind: "unavailable", reason: "upstreamDown" });
    expect(screen.getByRole("status")).toHaveTextContent(/agent isn't reachable/i);
    expect(screen.queryByRole("button", { name: /report/i })).not.toBeInTheDocument();
  });

  it("offers a bug report once the agent has stayed down", () => {
    renderWith({ kind: "unavailable", reason: "upstreamDown", escalated: true });
    expect(screen.getByRole("button", { name: /report/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^try again$/i })).toBeInTheDocument();
  });

  it("Try again after escalation reconnects, Reload reloads the page", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const { retryHistory } = renderWith({
      kind: "unavailable",
      reason: "unreachable",
      escalated: true,
    });
    await userEvent.click(screen.getByRole("button", { name: /^try again$/i }));
    expect(retryHistory).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /^reload$/i }));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("keeps the composer draft when Try again recreates the connection", async () => {
    renderWith({ kind: "unavailable", reason: "unreachable", escalated: true });
    const draft = screen.getByLabelText("draft");
    await userEvent.type(draft, "half-written question");
    await userEvent.click(screen.getByRole("button", { name: /^try again$/i }));
    expect(screen.getByLabelText("draft")).toBe(draft);
    expect(screen.getByLabelText("draft")).toHaveValue("half-written question");
  });

  it("shows no connection buttons when everything is fine", () => {
    renderWith({ kind: "ready" });
    expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
  });
});
