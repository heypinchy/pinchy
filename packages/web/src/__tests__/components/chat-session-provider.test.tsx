import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  ChatSessionProvider,
  MAX_LIVE_BUNDLES,
  useChatSession,
  useChatSessionHasInlineError,
  useVisitedAgentIds,
  useVisitedSessions,
  type RuntimeBundle,
} from "@/components/chat-session-provider";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ChatSessionProvider>{children}</ChatSessionProvider>
);

function fakeBundle(overrides: Partial<RuntimeBundle> = {}): RuntimeBundle {
  return {
    agentId: "fake-agent",
    runtime: { __id: "fake-runtime" } as never,
    isRunning: false,
    isConnected: true,
    isHistoryLoaded: true,
    isReconcilingMessages: false,
    hasInitialContent: true,
    isOpenClawConnected: true,
    isDelayed: false,
    reconnectExhausted: false,
    payloadRejected: false,
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

  describe("useChatSessionHasInlineError (#583)", () => {
    it("returns false when the session has no bundle", () => {
      const { result } = renderHook(() => useChatSessionHasInlineError("agent-1"), { wrapper });
      expect(result.current).toBe(false);
    });

    it("reflects the published bundle's hasInlineError flag", () => {
      const { result } = renderHook(
        () => ({
          session: useChatSession("agent-1"),
          hasInlineError: useChatSessionHasInlineError("agent-1"),
        }),
        { wrapper }
      );

      act(() => result.current.session.publish(fakeBundle({ hasInlineError: true })));
      expect(result.current.hasInlineError).toBe(true);
    });

    it("defaults to false when the flag is absent (legacy placeholder bundle)", () => {
      const { result } = renderHook(
        () => ({
          session: useChatSession("agent-1"),
          hasInlineError: useChatSessionHasInlineError("agent-1"),
        }),
        { wrapper }
      );

      act(() => result.current.session.publish(fakeBundle()));
      expect(result.current.hasInlineError).toBe(false);
    });

    it("does not throw outside a ChatSessionProvider (non-throwing fallback)", () => {
      const { result } = renderHook(() => useChatSessionHasInlineError("agent-1"));
      expect(result.current).toBe(false);
    });
  });

  it("remove() clears the bundle for that agent", () => {
    const { result } = renderHook(() => useChatSession("agent-A"), { wrapper });

    act(() => result.current.publish(fakeBundle()));
    expect(result.current.bundle).toBeDefined();

    act(() => result.current.remove());
    expect(result.current.bundle).toBeUndefined();
  });

  describe("chatId session keying (#508)", () => {
    it("isolates bundles for the same agent across different chatIds", () => {
      const { result } = renderHook(
        () => ({
          legacy: useChatSession("agent-A"),
          chatX: useChatSession("agent-A", "chat-x"),
          chatY: useChatSession("agent-A", "chat-y"),
        }),
        { wrapper }
      );

      act(() => result.current.chatX.publish(fakeBundle({ agentId: "agent-A", isRunning: true })));

      // Only the chat-x bundle exists; the legacy and chat-y keys stay empty.
      expect(result.current.chatX.bundle?.isRunning).toBe(true);
      expect(result.current.legacy.bundle).toBeUndefined();
      expect(result.current.chatY.bundle).toBeUndefined();
    });

    it("keeps the legacy (no-chatId) bundle independent from a chat-scoped one", () => {
      const { result } = renderHook(
        () => ({
          legacy: useChatSession("agent-A"),
          chatX: useChatSession("agent-A", "chat-x"),
        }),
        { wrapper }
      );

      act(() =>
        result.current.legacy.publish(fakeBundle({ agentId: "agent-A", hasInitialContent: true }))
      );

      expect(result.current.legacy.bundle?.hasInitialContent).toBe(true);
      expect(result.current.chatX.bundle).toBeUndefined();
    });

    it("useVisitedSessions reports agentId + chatId for each live session", () => {
      const { result } = renderHook(
        () => ({
          sessions: useVisitedSessions(),
          publishLegacy: useChatSession("agent-A").publish,
          publishChat: useChatSession("agent-A", "chat-x").publish,
        }),
        { wrapper }
      );

      expect(result.current.sessions).toEqual([]);

      act(() => result.current.publishLegacy(fakeBundle({ agentId: "agent-A" })));
      act(() => result.current.publishChat(fakeBundle({ agentId: "agent-A", chatId: "chat-x" })));

      const byKey = Object.fromEntries(result.current.sessions.map((s) => [s.key, s]));
      expect(byKey["agent-A"]).toEqual({ key: "agent-A", agentId: "agent-A", chatId: undefined });
      expect(byKey["agent-A:chat-x"]).toEqual({
        key: "agent-A:chat-x",
        agentId: "agent-A",
        chatId: "chat-x",
      });
    });
  });

  describe("LRU eviction (MAX_LIVE_BUNDLES cap)", () => {
    // Each bundle pins one WebSocket connection (via the surviving
    // ChatSessionInstance) and up to MAX_BUNDLED_MESSAGES messages.
    // Without a cap, a long-lived tab that opens many agents accumulates
    // unbounded WebSockets and memory. The store evicts the
    // least-recently-published agent once the cap is exceeded so the
    // resource budget stays bounded; the evicted agent reconnects fresh
    // when the user navigates back to it.

    it("keeps exactly MAX_LIVE_BUNDLES bundles alive across many publishes", () => {
      // Probe component that publishes on mount via render-time call —
      // same pattern <Chat> uses for its placeholder publish.
      function PublishOnMount({ id }: { id: string }) {
        const session = useChatSession(id);
        if (!session.bundle) session.publish(fakeBundle());
        return null;
      }

      const allIds = Array.from({ length: MAX_LIVE_BUNDLES + 5 }, (_, i) => `lru-${i}`);

      const { result } = renderHook(() => useVisitedAgentIds(), {
        wrapper: ({ children }) => (
          <ChatSessionProvider>
            {allIds.map((id) => (
              <PublishOnMount key={id} id={id} />
            ))}
            {children}
          </ChatSessionProvider>
        ),
      });

      // The cap holds: never more than MAX_LIVE_BUNDLES alive.
      expect(result.current.length).toBe(MAX_LIVE_BUNDLES);
      // The earliest publishes were evicted; the most recent ones survive.
      const expectedSurvivors = allIds.slice(-MAX_LIVE_BUNDLES).sort();
      expect([...result.current].sort()).toEqual(expectedSurvivors);
    });

    it("re-publishing an existing agent moves it to the most-recently-used position", () => {
      // Sequence: publish A, publish B..(MAX-1), re-publish A, publish a new id.
      // Without LRU, A would be evicted (it was first). With LRU, the
      // newest of the original B..(MAX-1) gets evicted instead because
      // re-publishing A bumped it to MRU.

      const publishers = new Map<string, (b: RuntimeBundle) => void>();

      function PublishHarness({ id }: { id: string }) {
        const session = useChatSession(id);
        publishers.set(id, session.publish);
        return null;
      }

      const filler = Array.from({ length: MAX_LIVE_BUNDLES - 1 }, (_, i) => `filler-${i}`);
      const allIds = ["a", ...filler];

      const { result } = renderHook(() => useVisitedAgentIds(), {
        wrapper: ({ children }) => (
          <ChatSessionProvider>
            {allIds.map((id) => (
              <PublishHarness key={id} id={id} />
            ))}
            <PublishHarness key="overflow" id="overflow" />
            {children}
          </ChatSessionProvider>
        ),
      });

      // Step 1: publish a, then all fillers — store now has MAX entries
      // (a + MAX_LIVE_BUNDLES - 1 fillers).
      act(() => {
        publishers.get("a")!(fakeBundle());
        for (const id of filler) publishers.get(id)!(fakeBundle());
      });
      expect(result.current.length).toBe(MAX_LIVE_BUNDLES);
      expect(result.current).toContain("a");

      // Step 2: re-publish "a" — moves it to MRU. Now oldest is filler-0.
      act(() => publishers.get("a")!(fakeBundle()));

      // Step 3: publish "overflow" — exceeds cap, evicts oldest. Without
      // the bump on "a", "a" would be the oldest and would get evicted.
      // With the bump, "filler-0" is oldest and gets evicted instead.
      act(() => publishers.get("overflow")!(fakeBundle()));

      expect(result.current.length).toBe(MAX_LIVE_BUNDLES);
      expect(result.current).toContain("a"); // "a" survived because it was bumped
      expect(result.current).not.toContain("filler-0"); // oldest got evicted
      expect(result.current).toContain("overflow");
    });
  });
});

// Helper component: subscribes to agent-B and calls onRender each render.
function RenderCounter({ id, onRender }: { id: string; onRender: () => void }) {
  onRender();
  useChatSession(`agent-${id}`);
  return null;
}
