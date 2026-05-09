import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import {
  ChatSessionProvider,
  useChatSession,
  type RuntimeBundle,
} from "@/components/chat-session-provider";
import { AgentSidebarIndicator } from "@/components/agent-sidebar-indicator";

function makeBundle(overrides: Partial<RuntimeBundle> = {}): RuntimeBundle {
  return {
    runtime: {} as never,
    isRunning: false,
    isConnected: true,
    isHistoryLoaded: true,
    hasInitialContent: true,
    isOpenClawConnected: true,
    isDelayed: false,
    reconnectExhausted: false,
    isOrphaned: false,
    onRetryContinue: vi.fn() as (
      reason: "orphan" | "partial_stream_failure" | "send_failure"
    ) => void,
    onRetryResend: vi.fn(),
    lastError: null,
    ...overrides,
  };
}

describe("AgentSidebarIndicator", () => {
  it("renders nothing when no bundle exists for the agent", () => {
    render(
      <ChatSessionProvider>
        <AgentSidebarIndicator agentId="agent-A" />
      </ChatSessionProvider>
    );
    expect(screen.queryByTestId("agent-running-indicator")).toBeNull();
  });

  it("renders the running indicator when bundle.isRunning=true", () => {
    function Helper() {
      const { publish } = useChatSession("agent-A");
      return (
        <button data-testid="seed" onClick={() => publish(makeBundle({ isRunning: true }))}>
          seed
        </button>
      );
    }
    render(
      <ChatSessionProvider>
        <Helper />
        <AgentSidebarIndicator agentId="agent-A" />
      </ChatSessionProvider>
    );

    act(() => {
      screen.getByTestId("seed").click();
    });

    expect(screen.getByTestId("agent-running-indicator")).toBeInTheDocument();
  });

  it("removes the indicator when isRunning flips back to false", () => {
    // Drive state via button clicks to stay lint-clean (no ref/var mutation during render).
    function Controls() {
      const { publish } = useChatSession("agent-A");
      return (
        <>
          <button data-testid="start" onClick={() => publish(makeBundle({ isRunning: true }))}>
            start
          </button>
          <button data-testid="stop" onClick={() => publish(makeBundle({ isRunning: false }))}>
            stop
          </button>
        </>
      );
    }

    render(
      <ChatSessionProvider>
        <Controls />
        <AgentSidebarIndicator agentId="agent-A" />
      </ChatSessionProvider>
    );

    act(() => screen.getByTestId("start").click());
    expect(screen.getByTestId("agent-running-indicator")).toBeInTheDocument();

    act(() => screen.getByTestId("stop").click());
    expect(screen.queryByTestId("agent-running-indicator")).toBeNull();
  });
});
