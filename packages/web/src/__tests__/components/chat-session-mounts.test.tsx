import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useState } from "react";
import { ChatSessionProvider, useChatSession } from "@/components/chat-session-provider";
import { ChatSessionMounts } from "@/components/chat-session-mounts";

// Mutable state that tests can override to control useWsRuntime's return value.
let mockIsRunning = false;
let mockReconnectExhausted = false;
let mockPayloadRejected = false;
let mockPathname = "/agents";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

// Mock useWsRuntime to avoid opening real WebSockets in unit tests.
const useWsRuntimeSpy = vi.fn();

vi.mock("@/hooks/use-ws-runtime", () => ({
  useWsRuntime: (agentId: string, chatId?: string) => {
    useWsRuntimeSpy(agentId, chatId);
    return {
      runtime: { __id: `rt-${agentId}` } as never,
      isRunning: mockIsRunning,
      isConnected: true,
      isHistoryLoaded: true,
      isReconcilingMessages: false,
      hasInitialContent: true,
      isOpenClawConnected: true,
      isDelayed: false,
      reconnectExhausted: mockReconnectExhausted,
      payloadRejected: mockPayloadRejected,
      onRetryContinue: vi.fn(),
      onRetryResend: vi.fn(),
    };
  },
}));

function seedBundle(agentId: string, publish: (b: any) => void) {
  publish({
    agentId,
    runtime: { __id: `seed-${agentId}` } as never,
    isRunning: false,
    isConnected: false,
    isHistoryLoaded: false,
    isReconcilingMessages: false,
    hasInitialContent: false,
    isOpenClawConnected: false,
    isDelayed: false,
    reconnectExhausted: false,
    payloadRejected: false,
    onRetryContinue: vi.fn(),
    onRetryResend: vi.fn(),
    lastError: null,
  });
}

describe("ChatSessionMounts", () => {
  beforeEach(() => {
    mockIsRunning = false;
    mockReconnectExhausted = false;
    mockPayloadRejected = false;
    mockPathname = "/agents";
  });

  it("calls useWsRuntime once per visited agentId", () => {
    function Visitor({ agentIds }: { agentIds: string[] }) {
      agentIds.forEach((id) => {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const session = useChatSession(id);
        if (!session.bundle) seedBundle(id, session.publish);
      });
      return null;
    }

    useWsRuntimeSpy.mockClear();

    render(
      <ChatSessionProvider>
        <Visitor agentIds={["agent-A", "agent-B"]} />
        <ChatSessionMounts />
      </ChatSessionProvider>
    );

    // chatId is undefined for legacy (no-chatId) sessions (#508).
    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-A", undefined);
    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-B", undefined);
  });

  it("passes the chatId to useWsRuntime for a chat-scoped session (#508)", () => {
    function Visitor() {
      const session = useChatSession("agent-A", "chat-x");
      if (!session.bundle) {
        session.publish({
          agentId: "agent-A",
          chatId: "chat-x",
          runtime: { __id: "seed-agent-A:chat-x" } as never,
          isRunning: false,
          isConnected: false,
          isHistoryLoaded: false,
          isReconcilingMessages: false,
          hasInitialContent: false,
          isOpenClawConnected: false,
          isDelayed: false,
          reconnectExhausted: false,
          payloadRejected: false,
          isOrphaned: false,
          onRetryContinue: vi.fn(),
          onRetryResend: vi.fn(),
          lastError: null,
        } as any);
      }
      return null;
    }

    useWsRuntimeSpy.mockClear();

    render(
      <ChatSessionProvider>
        <Visitor />
        <ChatSessionMounts />
      </ChatSessionProvider>
    );

    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-A", "chat-x");
  });

  it("keeps a mount alive when an unrelated child remounts", () => {
    useWsRuntimeSpy.mockClear();

    function Page({ visible }: { visible: boolean }) {
      const session = useChatSession("agent-A");
      if (!session.bundle && visible) {
        seedBundle("agent-A", session.publish);
      }
      return visible ? <div>page</div> : <div>other</div>;
    }

    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <ChatSessionProvider>
          <button data-testid="toggle" onClick={() => setVisible((v) => !v)}>
            t
          </button>
          <Page visible={visible} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );
    }

    const { getByTestId } = render(<Harness />);

    act(() => {
      getByTestId("toggle").click();
    });
    act(() => {
      getByTestId("toggle").click();
    });

    const aCalls = useWsRuntimeSpy.mock.calls.filter((c: string[]) => c[0] === "agent-A");
    expect(aCalls.length).toBeGreaterThanOrEqual(1);
    expect(aCalls.length).toBeLessThanOrEqual(3);
  });

  describe("background-run telemetry", () => {
    function TelemetryHarness({ agentId, trigger }: { agentId: string; trigger: number }) {
      const session = useChatSession(agentId);
      if (!session.bundle) seedBundle(agentId, session.publish);
      // Expose trigger so re-renders happen when it changes
      return <span data-trigger={trigger} />;
    }

    it("calls fetch when isRunning flips true → false and user is NOT on the agent chat page", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" });
      vi.stubGlobal("fetch", fetchMock);

      mockPathname = "/agents";
      mockIsRunning = true;

      const { rerender } = render(
        <ChatSessionProvider>
          <TelemetryHarness agentId="agent-telemetry" trigger={1} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );

      // Simulate turn ending: flip isRunning to false and force a re-render
      mockIsRunning = false;
      await act(async () => {
        rerender(
          <ChatSessionProvider>
            <TelemetryHarness agentId="agent-telemetry" trigger={2} />
            <ChatSessionMounts />
          </ChatSessionProvider>
        );
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/internal/audit/background-run",
        expect.objectContaining({ method: "POST" })
      );

      vi.unstubAllGlobals();
    });

    it("does NOT call fetch when isRunning flips true → false and user IS on the agent chat page", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" });
      vi.stubGlobal("fetch", fetchMock);

      mockPathname = "/chat/agent-on-chat";
      mockIsRunning = true;

      const { rerender } = render(
        <ChatSessionProvider>
          <TelemetryHarness agentId="agent-on-chat" trigger={1} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );

      mockIsRunning = false;
      await act(async () => {
        rerender(
          <ChatSessionProvider>
            <TelemetryHarness agentId="agent-on-chat" trigger={2} />
            <ChatSessionMounts />
          </ChatSessionProvider>
        );
      });

      expect(fetchMock).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("does NOT call fetch on initial render when isRunning is already false", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" });
      vi.stubGlobal("fetch", fetchMock);

      mockPathname = "/agents";
      mockIsRunning = false;

      await act(async () => {
        render(
          <ChatSessionProvider>
            <TelemetryHarness agentId="agent-cold-start" trigger={1} />
            <ChatSessionMounts />
          </ChatSessionProvider>
        );
      });

      expect(fetchMock).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  describe("lastError publishing", () => {
    function Harness({ agentId, onBundle }: { agentId: string; onBundle: (b: any) => void }) {
      const session = useChatSession(agentId);
      // Seed once so ChatSessionMounts mounts the instance for this agent.
      if (!session.bundle) seedBundle(agentId, session.publish);
      if (session.bundle) onBundle(session.bundle);
      return null;
    }

    function lastBundleFor(agentId: string, mockSetup: () => void) {
      mockSetup();
      const observed: any[] = [];
      render(
        <ChatSessionProvider>
          <Harness agentId={agentId} onBundle={(b) => observed.push(b)} />
          <ChatSessionMounts />
        </ChatSessionProvider>
      );
      // Last bundle observed reflects ChatSessionInstance's useEffect publish
      // (which overwrites the seed with the real useWsRuntime values).
      return observed[observed.length - 1];
    }

    it("publishes lastError='Connection lost...' when bundle.reconnectExhausted is true", () => {
      const bundle = lastBundleFor("agent-exhausted", () => {
        mockReconnectExhausted = true;
      });
      expect(bundle?.lastError).toMatch(/connection lost/i);
    });

    it("publishes lastError=null when reconnectExhausted is not set", () => {
      // Per-turn failures are now authoritative `liveness: failed` verdicts
      // rendered as a thread bubble — they are NOT surfaced as a sidebar
      // lastError. Reconnect exhaustion is the only sidebar error.
      const bundle = lastBundleFor("agent-healthy", () => {});
      expect(bundle?.lastError).toBeNull();
    });
  });
});
