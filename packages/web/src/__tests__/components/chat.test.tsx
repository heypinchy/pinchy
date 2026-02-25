import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Chat } from "@/components/chat";

vi.mock("@/hooks/use-ws-runtime", () => ({
  useWsRuntime: vi.fn().mockReturnValue({
    runtime: {},
    isConnected: true,
    isDelayed: false,
    isHistoryLoaded: true,
  }),
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/assistant-ui/thread", () => ({
  Thread: (props: any) => (
    <div data-testid="thread" data-history-loaded={props.isHistoryLoaded}>
      Thread
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

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: true,
      isDelayed: false,
      isHistoryLoaded: true,
    });
  });

  it("should pass isHistoryLoaded to Thread", () => {
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: true,
      isDelayed: false,
      isHistoryLoaded: true,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const thread = screen.getByTestId("thread");
    expect(thread).toHaveAttribute("data-history-loaded", "true");
  });

  it("should pass isHistoryLoaded=false to Thread when not loaded", () => {
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: true,
      isDelayed: false,
      isHistoryLoaded: false,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const thread = screen.getByTestId("thread");
    expect(thread).toHaveAttribute("data-history-loaded", "false");
  });

  it("should render agent name in header", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByText("Smithers")).toBeInTheDocument();
  });

  it("should show connected status indicator when WebSocket is connected", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const dot = screen.getByLabelText("Connected");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-green-600");
  });

  it("should render the Thread component", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByTestId("thread")).toBeInTheDocument();
  });

  it("should show disconnected status indicator when WebSocket is not connected", () => {
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: false,
      isDelayed: false,
      isHistoryLoaded: false,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const dot = screen.getByLabelText("Disconnected");
    expect(dot).toBeInTheDocument();
    expect(dot.className).toContain("bg-destructive");
  });

  it("should show 'Applying your changes' in status tooltip when configuring", () => {
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: false,
      isDelayed: false,
      isHistoryLoaded: false,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" configuring={true} />);
    expect(screen.getByLabelText(/applying your changes/i)).toBeInTheDocument();
  });

  it("should render a settings link with correct href", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const settingsLink = screen.getByRole("link", { name: /settings/i });
    expect(settingsLink).toBeInTheDocument();
    expect(settingsLink).toHaveAttribute("href", "/chat/agent-1/settings");
  });

  it("should render a New Chat button", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const newChatButton = screen.getByRole("button", { name: /new chat/i });
    expect(newChatButton).toBeInTheDocument();
  });

  it("should reload the page when New Chat is clicked", () => {
    const reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { reload: reloadMock },
      writable: true,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" />);
    const newChatButton = screen.getByRole("button", { name: /new chat/i });
    fireEvent.click(newChatButton);

    expect(reloadMock).toHaveBeenCalled();
  });

  it("should render the settings link with the correct agent-specific href", () => {
    render(<Chat agentId="my-special-agent" agentName="Test Agent" />);
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

  it("should show delayed response hint when isDelayed is true", () => {
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: true,
      isDelayed: true,
      isHistoryLoaded: true,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument();
  });

  it("should not show delayed response hint when isDelayed is false", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument();
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
});
