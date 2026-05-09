import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useState } from "react";
import { ChatSessionProvider, useChatSession } from "@/components/chat-session-provider";
import { ChatSessionMounts } from "@/components/chat-session-mounts";

// Mutable state that tests can override to control useWsRuntime's return value.
let mockIsRunning = false;
let mockIsOrphaned = false;
let mockReconnectExhausted = false;
let mockPathname = "/agents";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

// Mock useWsRuntime to avoid opening real WebSockets in unit tests.
const useWsRuntimeSpy = vi.fn();

vi.mock("@/hooks/use-ws-runtime", () => ({
  useWsRuntime: (agentId: string) => {
    useWsRuntimeSpy(agentId);
    return {
      runtime: { __id: `rt-${agentId}` } as never,
      isRunning: mockIsRunning,
      isConnected: true,
      isHistoryLoaded: true,
      hasInitialContent: true,
      isOpenClawConnected: true,
      isDelayed: false,
      reconnectExhausted: mockReconnectExhausted,
      isOrphaned: mockIsOrphaned,
      onRetryContinue: vi.fn(),
      onRetryResend: vi.fn(),
    };
  },
}));

function seedBundle(agentId: string, publish: (b: any) => void) {
  publish({
    runtime: { __id: `seed-${agentId}` } as never,
    isRunning: false,
    isConnected: false,
    isHistoryLoaded: false,
    hasInitialContent: false,
    isOpenClawConnected: false,
    isDelayed: false,
    reconnectExhausted: false,
    isOrphaned: false,
    onRetryContinue: vi.fn(),
    onRetryResend: vi.fn(),
    lastError: null,
  });
}

describe("ChatSessionMounts", () => {
  beforeEach(() => {
    mockIsRunning = false;
    mockIsOrphaned = false;
    mockReconnectExhausted = false;
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

    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-A");
    expect(useWsRuntimeSpy).toHaveBeenCalledWith("agent-B");
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

    it("publishes lastError='The agent did not respond' when bundle.isOrphaned is true", () => {
      const bundle = lastBundleFor("agent-orphan", () => {
        mockIsOrphaned = true;
      });
      expect(bundle?.lastError).toBe("The agent did not respond");
    });

    it("publishes lastError='Connection lost...' when bundle.reconnectExhausted is true", () => {
      const bundle = lastBundleFor("agent-exhausted", () => {
        mockReconnectExhausted = true;
      });
      expect(bundle?.lastError).toMatch(/connection lost/i);
    });

    it("publishes lastError=null when neither isOrphaned nor reconnectExhausted is set", () => {
      const bundle = lastBundleFor("agent-healthy", () => {});
      expect(bundle?.lastError).toBeNull();
    });

    it("prefers reconnectExhausted message over isOrphaned when both are true", () => {
      // reconnectExhausted is the more severe state — the user can't recover
      // without reloading, while isOrphaned just means the current turn timed
      // out. The more-severe message wins so the sidebar tooltip is actionable.
      const bundle = lastBundleFor("agent-both", () => {
        mockIsOrphaned = true;
        mockReconnectExhausted = true;
      });
      expect(bundle?.lastError).toMatch(/connection lost/i);
    });
  });
});
