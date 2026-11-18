// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useEffect, useState } from "react";
import { renderHook, act } from "@testing-library/react";
import {
  ChatSessionProvider,
  MAX_LIVE_BUNDLES,
  useAgentActivity,
  useChatSession,
  useChatSessionHasInlineError,
  useTouchChatSession,
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
    pendingUploads: [],
    addPendingUpload: vi.fn(),
    removePendingUpload: vi.fn(),
    retryPendingUpload: vi.fn(),
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

  describe("useAgentActivity (sidebar indicator — ANY session, not just the first)", () => {
    it("returns not-running / no-error when the agent has no sessions", () => {
      const { result } = renderHook(() => useAgentActivity("agent-1"), { wrapper });
      expect(result.current).toEqual({ isRunning: false, lastError: null });
    });

    it("reports running when a NON-default (chat-scoped) session is running", () => {
      // The reported bug: the sidebar indicator read only the default session's
      // bundle, so writing in another chat of the same agent lit nothing. It
      // must reflect a run in ANY of the agent's sessions.
      const { result } = renderHook(
        () => ({
          activity: useAgentActivity("agent-A"),
          legacy: useChatSession("agent-A"),
          chatX: useChatSession("agent-A", "chat-x"),
        }),
        { wrapper }
      );

      // Default session idle, a different chat's session running.
      act(() =>
        result.current.legacy.publish(fakeBundle({ agentId: "agent-A", isRunning: false }))
      );
      act(() =>
        result.current.chatX.publish(
          fakeBundle({ agentId: "agent-A", chatId: "chat-x", isRunning: true })
        )
      );

      expect(result.current.activity.isRunning).toBe(true);
    });

    it("does not leak activity across agents (matches by agentId, not key prefix)", () => {
      // Guard against a naive key-prefix match: "agent-A" is a prefix of
      // "agent-A2", so matching on the store key would false-positive.
      const { result } = renderHook(
        () => ({
          activityA: useAgentActivity("agent-A"),
          publishA2: useChatSession("agent-A2").publish,
        }),
        { wrapper }
      );

      act(() => result.current.publishA2(fakeBundle({ agentId: "agent-A2", isRunning: true })));
      expect(result.current.activityA.isRunning).toBe(false);
    });

    it("surfaces lastError from any of the agent's sessions", () => {
      const { result } = renderHook(
        () => ({
          activity: useAgentActivity("agent-A"),
          chatX: useChatSession("agent-A", "chat-x"),
        }),
        { wrapper }
      );

      act(() =>
        result.current.chatX.publish(
          fakeBundle({ agentId: "agent-A", chatId: "chat-x", lastError: "Reconnect exhausted" })
        )
      );
      expect(result.current.activity.lastError).toBe("Reconnect exhausted");
    });

    it("does not throw outside a ChatSessionProvider (non-throwing fallback)", () => {
      const { result } = renderHook(() => useAgentActivity("agent-1"));
      expect(result.current).toEqual({ isRunning: false, lastError: null });
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

    it("re-publishing an existing agent keeps its place in the eviction order", () => {
      // A background chat republishes whenever its socket does anything (a
      // reconnect, a finished run). That is not the user looking at it, so it
      // must not push a long-unviewed chat back to the front of the line.
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

      act(() => {
        publishers.get("a")!(fakeBundle());
        for (const id of filler) publishers.get(id)!(fakeBundle());
      });
      expect(result.current.length).toBe(MAX_LIVE_BUNDLES);

      // "a" republishes from the background, then a new chat opens.
      act(() => publishers.get("a")!(fakeBundle()));
      act(() => publishers.get("overflow")!(fakeBundle()));

      expect(result.current.length).toBe(MAX_LIVE_BUNDLES);
      expect(result.current).not.toContain("a"); // still the least recently viewed
      expect(result.current).toContain("filler-0");
      expect(result.current).toContain("overflow");
    });

    // The server allows 10 sockets per user across all devices and tabs (#957),
    // so one tab must hold only a few idle ones.
    function setup() {
      const publishers = new Map<string, (b: RuntimeBundle) => void>();
      function Harness({ id }: { id: string }) {
        const session = useChatSession(id);
        publishers.set(id, session.publish);
        return null;
      }
      // Stands in for <Chat>: the chat on screen touches its session.
      function Touch({ id }: { id: string }) {
        useTouchChatSession(id);
        return null;
      }
      const viewer = { set: (_id: string) => {} };
      function Viewer() {
        const [viewed, setState] = useState<string | null>(null);
        useEffect(() => {
          viewer.set = setState;
        }, []);
        return viewed ? <Touch key={viewed} id={viewed} /> : null;
      }
      const ids = ["a", "b", "c", "d", "e", "f"];
      const { result } = renderHook(() => useVisitedAgentIds(), {
        wrapper: ({ children }) => (
          <ChatSessionProvider>
            {ids.map((id) => (
              <Harness key={id} id={id} />
            ))}
            <Viewer />
            {children}
          </ChatSessionProvider>
        ),
      });
      const view = (id: string) => act(() => viewer.set(id));
      const pub = (id: string, isRunning = false) =>
        act(() => publishers.get(id)!(fakeBundle({ agentId: id, isRunning })));
      const pubWith = (id: string, overrides: Partial<RuntimeBundle> = {}) =>
        act(() => publishers.get(id)!(fakeBundle({ agentId: id, ...overrides })));
      return { result, pub, pubWith, view };
    }

    it("caps a tab at three live bundles", () => {
      expect(MAX_LIVE_BUNDLES).toBe(3);
    });

    it("evicts the least recently viewed chat first", () => {
      const { result, pub, view } = setup();
      pub("a");
      pub("b");
      pub("c");
      view("a"); // the user goes back to a, so b is now the least recently viewed
      pub("d");
      expect([...result.current].sort()).toEqual(["a", "c", "d"]);
    });

    it("viewing a chat that is not mounted changes nothing", () => {
      const { result, pub, view } = setup();
      pub("a");
      view("f");
      expect(result.current).toEqual(["a"]);
    });

    it("never evicts a running bundle, even when it is the oldest", () => {
      const { result, pub } = setup();
      pub("a", true);
      pub("b");
      pub("c");
      pub("d");
      // a is the oldest but mid-run, so the next-oldest idle one (b) goes.
      expect([...result.current].sort()).toEqual(["a", "c", "d"]);
    });

    it("overshoots the cap while every bundle is running, then trims once runs finish", () => {
      const { result, pub } = setup();
      pub("a", true);
      pub("b", true);
      pub("c", true);
      pub("d", true);
      expect(result.current.length).toBe(4);

      // Runs finish and are republished idle; the next publish trims back down.
      pub("a");
      pub("b");
      pub("c");
      pub("d");
      pub("e");
      expect(result.current.length).toBe(MAX_LIVE_BUNDLES);
      expect([...result.current].sort()).toEqual(["c", "d", "e"]);
    });

    it("never evicts the chat on screen when a background run finishes", () => {
      const { result, pub } = setup();
      pub("a", true);
      pub("b", true);
      pub("c", true);
      pub("e"); // the chat being opened, idle, newest
      pub("a"); // a's run finished and its instance republishes it
      expect(result.current).toContain("e");
      expect(result.current.length).toBe(4);
    });

    it("never evicts a chat with a message queued for the next connection", () => {
      // A failed reconnect drops isRunning, but the queued message exists only
      // in the instance; evicting it would lose what the user sent.
      const { result, pubWith } = setup();
      pubWith("a", { hasQueuedMessage: true });
      pubWith("b");
      pubWith("c");
      pubWith("d");
      expect([...result.current].sort()).toEqual(["a", "c", "d"]);
    });

    it("never evicts a chat whose composer still holds attachments", () => {
      // Staged uploads live only in the instance's state; nothing restores them
      // on remount, so evicting the chat would silently drop the user's file.
      const { result, pubWith } = setup();
      pubWith("a", {
        pendingUploads: [
          { localId: "u1", state: "ready" } as RuntimeBundle["pendingUploads"][number],
        ],
      });
      pubWith("b");
      pubWith("c");
      pubWith("d");
      expect([...result.current].sort()).toEqual(["a", "c", "d"]);
    });

    it("keeps the bundle being published even when all others are running", () => {
      const { result, pub } = setup();
      pub("a", true);
      pub("b", true);
      pub("c", true);
      pub("d");
      expect(result.current).toContain("d");
      expect(result.current.length).toBe(4);
    });
  });
});

// Helper component: subscribes to agent-B and calls onRender each render.
function RenderCounter({ id, onRender }: { id: string; onRender: () => void }) {
  onRender();
  useChatSession(`agent-${id}`);
  return null;
}
