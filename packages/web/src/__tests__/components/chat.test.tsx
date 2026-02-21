import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Chat } from "@/components/chat";

vi.mock("@/hooks/use-ws-runtime", () => ({
  useWsRuntime: vi.fn().mockReturnValue({
    runtime: {},
    isConnected: true,
  }),
}));

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/assistant-ui/thread", () => ({
  Thread: () => <div data-testid="thread">Thread</div>,
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
    });
  });

  it("should render agent name in header", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByText("Smithers")).toBeInTheDocument();
  });

  it("should show 'Connected' when WebSocket is connected", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("should render the Thread component", () => {
    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByTestId("thread")).toBeInTheDocument();
  });

  it("should show 'Disconnected' when WebSocket is not connected", () => {
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: false,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("should show 'Applying your changes' when configuring", () => {
    vi.mocked(useWsRuntime).mockReturnValue({
      runtime: {} as any,
      isConnected: false,
    });

    render(<Chat agentId="agent-1" agentName="Smithers" configuring={true} />);
    expect(screen.getByText(/applying your changes/i)).toBeInTheDocument();
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
});
