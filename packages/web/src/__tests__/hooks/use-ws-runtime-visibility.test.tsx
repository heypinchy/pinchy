/**
 * Chat WebSocket lifecycle following tab visibility (#895).
 *
 * Before this change, `use-ws-runtime.ts` had no notion of "the tab is
 * hidden" for its own reconnect backoff: a scheduled reconnect timer dialed
 * regardless of visibility, and after MAX_RECONNECT_ATTEMPTS the connection
 * sat in `reconnectExhausted` forever — only a full reload recovered it, even
 * once the tab was visible and looked-at again.
 *
 * This suite pins three behaviors:
 *   1. Hidden tab: a pending reconnect timer must not dial; attempts are not
 *      consumed while hidden.
 *   2. Hidden longer than the grace period (~5 min) closes the WebSocket
 *      cleanly with no reconnect scheduled from that close; shorter hidden
 *      spells leave the connection open.
 *   3. Visible tab: reset the reconnect counter and reconnect immediately,
 *      including recovering out of `reconnectExhausted` — and once visible,
 *      retries keep going at the capped 5s interval (tolerating a ~10-20s
 *      server-unavailable window, e.g. a fleet-instance wake).
 *
 * Same mocking strategy as the canonical `use-ws-runtime.test.ts`: a real
 * WebSocket stub via `vi.stubGlobal`, `@assistant-ui/react` mocked to the
 * identity function.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";

vi.mock("@/lib/image-compression", () => ({
  compressImageForChat: vi.fn(async (file: File) => ({ ok: true, file, skipped: true })),
}));
vi.mock("@/lib/upload-attachment", () => ({ uploadAttachment: vi.fn() }));
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/components/restart-provider", () => ({
  useRestart: () => ({ isRestarting: false, triggerRestart: vi.fn() }),
}));
vi.mock("@assistant-ui/react", () => ({
  useExternalStoreRuntime: (config: unknown) => config,
  SimpleImageAttachmentAdapter: class {
    accept = "image/*";
  },
  SimpleTextAttachmentAdapter: class {
    accept = "text/plain";
  },
  CompositeAttachmentAdapter: class {
    accept: string;
    constructor(adapters: { accept: string }[]) {
      this.accept = adapters.map((a) => a.accept).join(",");
    }
  },
}));

let wsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();

  constructor() {
    wsInstances.push(this);
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

function latestWs(): MockWebSocket {
  const ws = wsInstances[wsInstances.length - 1];
  if (!ws) throw new Error("No MockWebSocket instance created yet");
  return ws;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

describe("useWsRuntime — visibility-driven reconnect lifecycle (#895)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
    setVisibility("visible");
  });

  afterEach(() => {
    setVisibility("visible");
    vi.useRealTimers();
  });

  it("does not dial a pending reconnect while hidden, and does not consume further attempts", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });

    // Disconnect while visible — schedules the first backoff reconnect (1s).
    act(() => {
      ws1.simulateClose();
    });

    // Now the tab goes hidden before that backoff fires.
    act(() => {
      setVisibility("hidden");
    });

    // Advance well past what would be many exponential-backoff cycles
    // (would normally exhaust all 10 attempts in under 45s). No dialing
    // should happen at all while hidden.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(wsInstances).toHaveLength(1);
    expect(result.current.reconnectExhausted).toBe(false);
    expect(result.current.isConnected).toBe(false);
  });

  it("keeps the WebSocket open when hidden for less than the grace period", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });
    expect(result.current.isConnected).toBe(true);

    act(() => {
      setVisibility("hidden");
    });

    act(() => {
      vi.advanceTimersByTime(FIVE_MINUTES_MS - 1000);
    });

    expect(ws1.close).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(true);
    expect(wsInstances).toHaveLength(1);
  });

  it("closes the WebSocket cleanly after the hidden grace period elapses, with no reconnect scheduled", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });

    act(() => {
      setVisibility("hidden");
    });

    act(() => {
      vi.advanceTimersByTime(FIVE_MINUTES_MS);
    });

    // Deliberate close: WS.close() invoked, no new connection dialed.
    expect(ws1.close).toHaveBeenCalledTimes(1);
    expect(result.current.isConnected).toBe(false);
    expect(wsInstances).toHaveLength(1);

    // The real browser follows close() with an onclose event. That close
    // must not schedule a reconnect (still hidden, and it was deliberate).
    act(() => {
      ws1.simulateClose(1000);
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(wsInstances).toHaveLength(1);
    expect(result.current.reconnectExhausted).toBe(false);
  });

  it("reconnects immediately with a reset counter when the tab becomes visible after reconnectExhausted", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });

    // Exhaust all MAX_RECONNECT_ATTEMPTS (10) + the original connection,
    // exactly like the canonical reconnectExhausted test — all while visible.
    for (let i = 0; i < 10; i++) {
      const ws = latestWs();
      act(() => {
        ws.simulateClose();
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    }
    const lastWs = latestWs();
    act(() => {
      lastWs.simulateClose();
    });

    expect(result.current.reconnectExhausted).toBe(true);
    const countAtExhaustion = wsInstances.length;

    // Tab becomes visible (e.g. the user switches back after the dead-end) —
    // must recover instantly, not stay stuck.
    act(() => {
      setVisibility("visible");
    });

    expect(result.current.reconnectExhausted).toBe(false);
    expect(wsInstances.length).toBeGreaterThan(countAtExhaustion);
  });

  it("keeps retrying at the capped 5s interval through a simulated ~20s outage after becoming visible, without premature exhaustion", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });

    // Trigger a visible-driven reconnect (simulates recovering from a
    // background/exhausted state) and then keep the "server" down for ~20s.
    act(() => {
      setVisibility("hidden");
    });
    act(() => {
      ws1.simulateClose();
    });
    act(() => {
      setVisibility("visible");
    });

    expect(wsInstances.length).toBeGreaterThan(1);

    // Simulate a ~20s outage: every reconnect attempt immediately fails.
    let elapsed = 0;
    while (elapsed < 20_000) {
      const ws = latestWs();
      act(() => {
        ws.simulateClose();
      });
      // Capped backoff — never exceeds 5s regardless of attempt count.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      elapsed += 5000;
    }

    // 20s / 5s-cap is well within the 10-attempt budget — must not be
    // exhausted yet.
    expect(result.current.reconnectExhausted).toBe(false);
  });

  it("restarts the full backoff budget on return from a grace-period close, even if the counter was already exhausted before going hidden", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });

    // Exhaust while visible, exactly like the canonical reconnectExhausted
    // test — the counter is now pinned at MAX_RECONNECT_ATTEMPTS and the
    // socket is gone (no ws instance left connected).
    for (let i = 0; i < 10; i++) {
      const ws = latestWs();
      act(() => {
        ws.simulateClose();
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
    }
    act(() => {
      latestWs().simulateClose();
    });
    expect(result.current.reconnectExhausted).toBe(true);
    const countBeforeHidden = wsInstances.length;

    // Now the tab goes hidden past the grace period — suspendForPageLifecycle
    // fires (there's no open socket to close, but it still marks the drop as
    // lifecycle-suspended so a later `visible` reopens through
    // recoverFromPageLifecycle instead of doing nothing).
    act(() => {
      setVisibility("hidden");
    });
    act(() => {
      vi.advanceTimersByTime(FIVE_MINUTES_MS);
    });

    // Tab becomes visible again, but the server is STILL down. Without the
    // counter reset, the very first reconnect attempt here would fail and
    // immediately re-flip reconnectExhausted (stale count already at MAX).
    act(() => {
      setVisibility("visible");
    });
    expect(result.current.reconnectExhausted).toBe(false);
    expect(wsInstances.length).toBeGreaterThan(countBeforeHidden);

    // Drive several more failed attempts at the capped 5s interval — the
    // budget must have restarted from zero, so reconnectExhausted must stay
    // false well past what a single stale attempt would have allowed.
    for (let i = 0; i < 5; i++) {
      const ws = latestWs();
      act(() => {
        ws.simulateClose();
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current.reconnectExhausted).toBe(false);
    }

    // A successful open fully recovers the connection.
    act(() => {
      latestWs().simulateOpen();
    });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.reconnectExhausted).toBe(false);
  });

  it("visible just before the grace period elapses cancels the pending grace close", () => {
    const { result } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });

    act(() => {
      setVisibility("hidden");
    });

    act(() => {
      vi.advanceTimersByTime(FIVE_MINUTES_MS - 1000);
    });
    expect(ws1.close).not.toHaveBeenCalled();

    act(() => {
      setVisibility("visible");
    });

    // The grace timer must be cancelled — advancing well past where it would
    // have fired must not close the (still open, never-suspended) socket.
    act(() => {
      vi.advanceTimersByTime(FIVE_MINUTES_MS);
    });

    expect(ws1.close).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(true);
    expect(wsInstances).toHaveLength(1);
  });

  it("clears the hidden-grace timer on unmount, leaving no leaked timers", () => {
    const { unmount } = renderHook(() => useWsRuntime("agent-1"));
    const ws1 = latestWs();

    act(() => {
      ws1.simulateOpen();
    });

    act(() => {
      setVisibility("hidden");
    });

    // Grace timer is now pending (armed for 5 minutes).
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    act(() => {
      unmount();
    });

    expect(vi.getTimerCount()).toBe(0);
  });
});
