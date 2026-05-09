import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useState } from "react";
import { ChatSessionProvider, useChatSession } from "@/components/chat-session-provider";
import { ChatSessionMounts } from "@/components/chat-session-mounts";

// Mock useWsRuntime to avoid opening real WebSockets in unit tests.
const useWsRuntimeSpy = vi.fn();

vi.mock("@/hooks/use-ws-runtime", () => ({
  useWsRuntime: (agentId: string) => {
    useWsRuntimeSpy(agentId);
    return {
      runtime: { __id: `rt-${agentId}` } as never,
      isRunning: false,
      isConnected: true,
      isHistoryLoaded: true,
      hasInitialContent: true,
      isOpenClawConnected: true,
      isDelayed: false,
      reconnectExhausted: false,
      isOrphaned: false,
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
});
