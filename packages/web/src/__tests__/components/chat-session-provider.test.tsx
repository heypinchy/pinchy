import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  ChatSessionProvider,
  useChatSession,
  useVisitedAgentIds,
  type RuntimeBundle,
} from "@/components/chat-session-provider";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ChatSessionProvider>{children}</ChatSessionProvider>
);

function fakeBundle(overrides: Partial<RuntimeBundle> = {}): RuntimeBundle {
  return {
    runtime: { __id: "fake-runtime" } as never,
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
    lastError: null,
    ...overrides,
  };
}

describe("ChatSessionProvider", () => {
  it("returns undefined for an agent that has not been visited", () => {
    const { result } = renderHook(() => useChatSession("agent-1"), { wrapper });
    expect(result.current.bundle).toBeUndefined();
  });

  it("publishes a bundle and exposes it via useChatSession", () => {
    const { result } = renderHook(
      () => {
        const session = useChatSession("agent-1");
        return session;
      },
      { wrapper }
    );

    act(() => {
      result.current.publish(fakeBundle({ isRunning: true }));
    });

    expect(result.current.bundle?.isRunning).toBe(true);
  });

  it("isolates re-renders per agentId", () => {
    let aRenders = 0;
    let bRenders = 0;

    // renderHook renders a single "host" component; wrap extra consumers as
    // siblings inside the same provider tree so they share the zustand store.
    const { result, rerender } = renderHook(
      () => {
        // track render counts via closures captured per render
        aRenders++;
        const sessionA = useChatSession("agent-A");
        return { publishA: sessionA.publish };
      },
      {
        wrapper: ({ children }) => (
          <ChatSessionProvider>
            {children}
            <RenderCounter id="b" onRender={() => bRenders++} />
          </ChatSessionProvider>
        ),
      }
    );
    rerender();

    const aBefore = aRenders;
    const bBefore = bRenders;

    act(() => {
      result.current.publishA(fakeBundle({ isRunning: true }));
    });

    expect(aRenders).toBeGreaterThan(aBefore);
    expect(bRenders).toBe(bBefore); // CRITICAL: B did not re-render
  });

  it("useVisitedAgentIds returns the set of agentIds with bundles", () => {
    // Combine all hooks into a single renderHook so they share one provider.
    const { result } = renderHook(
      () => ({
        ids: useVisitedAgentIds(),
        publishA: useChatSession("agent-A").publish,
        publishB: useChatSession("agent-B").publish,
      }),
      { wrapper }
    );

    expect(result.current.ids).toEqual([]);

    act(() => result.current.publishA(fakeBundle()));
    act(() => result.current.publishB(fakeBundle()));

    expect(result.current.ids.sort()).toEqual(["agent-A", "agent-B"]);
  });

  it("remove() clears the bundle for that agent", () => {
    const { result } = renderHook(() => useChatSession("agent-A"), { wrapper });

    act(() => result.current.publish(fakeBundle()));
    expect(result.current.bundle).toBeDefined();

    act(() => result.current.remove());
    expect(result.current.bundle).toBeUndefined();
  });
});

// Helper component: subscribes to agent-B and calls onRender each render.
function RenderCounter({ id, onRender }: { id: string; onRender: () => void }) {
  onRender();
  useChatSession(`agent-${id}`);
  return null;
}
