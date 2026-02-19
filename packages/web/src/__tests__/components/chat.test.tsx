import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
