// @vitest-environment jsdom
/**
 * The chat never parks on "Reconnecting" with no way out (#1422).
 *
 * One test per way the old reconnect loop could end in a dead state: a budget
 * that ran out, a CONNECTING socket nobody timed, a suspend whose recovery
 * hung on a single platform event, a half-open socket that still said OPEN, a
 * refusal the browser could not read, and a backoff reset that starved the
 * session check.
 *
 * Same mocking strategy as `use-ws-runtime-visibility.test.tsx`, except the
 * socket starts in CONNECTING and `close()` does NOT fire `onclose` — a real
 * socket tears down asynchronously, and a hook that only recovers through that
 * event is exactly what these tests are here to catch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWsRuntime } from "@/hooks/use-ws-runtime";

const mockLeaveDeactivatedAccount = vi.fn();
const mockSessionIsGone = vi.fn(async () => false);
vi.mock("@/lib/account-deactivated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-deactivated")>()),
  leaveDeactivatedAccount: () => mockLeaveDeactivatedAccount(),
  sessionIsGone: () => mockSessionIsGone(),
}));
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
  readyState = MockWebSocket.CONNECTING;
  send = vi.fn();
  // Deliberately silent: no `onclose` until a test fires one.
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSING;
  });

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

  simulateClose(code = 1006, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  /** What the browser would call the handshake with the server's own answer. */
  pings() {
    return this.send.mock.calls.filter(([raw]) => {
      try {
        return JSON.parse(raw as string).type === "ping";
      } catch {
        return false;
      }
    }).length;
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

function latestWs(): MockWebSocket {
  const ws = wsInstances[wsInstances.length - 1];
  if (!ws) throw new Error("No MockWebSocket instance created yet");
  return ws;
}

function setVisibility(state: "visible" | "hidden", dispatch = true) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  if (dispatch) document.dispatchEvent(new Event("visibilitychange"));
}

let onLine = true;
function setOnLine(value: boolean) {
  onLine = value;
}

function openHealthy() {
  act(() => {
    latestWs().simulateOpen();
    latestWs().simulateMessage({ type: "history", messages: [] });
  });
}

/** Fail the newest socket and let its backoff produce the next one. */
function failAndRedial(waitMs = 15_000) {
  const before = wsInstances.length;
  act(() => {
    latestWs().simulateClose(1006);
  });
  act(() => {
    vi.advanceTimersByTime(waitMs);
  });
  return wsInstances.length - before;
}

describe("useWsRuntime — the chat never gets stuck (#1422)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    wsInstances = [];
    onLine = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => onLine);
    mockSessionIsGone.mockResolvedValue(false);
    setVisibility("visible");
  });

  afterEach(() => {
    setVisibility("visible");
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("never gives up while the tab is visible (case 7)", () => {
    it("keeps dialing long after the old ten-attempt budget, with no exhausted state", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      for (let i = 0; i < 40; i++) {
        expect(failAndRedial()).toBeGreaterThanOrEqual(1);
      }
      expect(result.current).not.toHaveProperty("reconnectExhausted");
      expect(wsInstances.length).toBeGreaterThan(40);
    });

    it("caps the backoff at 15 s instead of 5 s", () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      renderHook(() => useWsRuntime("agent-1"));
      // 1, 2, 4, 8 s … then the 15 s cap.
      for (const wait of [1000, 2000, 4000, 8000]) failAndRedial(wait);
      act(() => {
        latestWs().simulateClose(1006);
      });
      const before = wsInstances.length;
      act(() => {
        vi.advanceTimersByTime(14_999);
      });
      expect(wsInstances.length).toBe(before);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(wsInstances.length).toBe(before + 1);
    });

    it("jitters the delay downwards so a crowd of tabs does not retry in lock-step", () => {
      const random = vi.spyOn(Math, "random").mockReturnValue(0);
      renderHook(() => useWsRuntime("agent-1"));
      for (const wait of [1000, 2000, 4000, 8000]) failAndRedial(wait);
      act(() => {
        latestWs().simulateClose(1006);
      });
      const before = wsInstances.length;
      act(() => {
        vi.advanceTimersByTime(12_000); // 80% of the 15 s cap
      });
      expect(wsInstances.length).toBe(before + 1);
      random.mockRestore();
    });
  });

  describe("a CONNECTING socket has a deadline (case 4)", () => {
    it("aborts a handshake that hangs for 10 s and counts it as a failed attempt", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const hung = latestWs(); // never opens, never closes
      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(hung.close).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(hung.close).toHaveBeenCalled();
      // …and the loop carries on although the browser never fired `onclose`.
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(wsInstances.length).toBeGreaterThan(1);
    });

    it("does not time out a handshake that opens in time", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const ws = latestWs();
      act(() => {
        vi.advanceTimersByTime(5_000);
        ws.simulateOpen();
        ws.simulateMessage({ type: "history", messages: [] });
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("aborts a CONNECTING socket the tab finds on return when its timer never got to run", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const hung = latestWs();
      setVisibility("hidden");
      // A frozen tab runs no timers; the clock still moves.
      vi.setSystemTime(Date.now() + 120_000);
      act(() => {
        setVisibility("visible");
      });
      expect(hung.close).toHaveBeenCalled();
      expect(wsInstances.length).toBeGreaterThan(1);
    });

    it("leaves a young CONNECTING socket alone when the tab becomes visible", () => {
      renderHook(() => useWsRuntime("agent-1"));
      const connecting = latestWs();
      act(() => {
        setVisibility("hidden");
        setVisibility("visible");
      });
      expect(connecting.close).not.toHaveBeenCalled();
      expect(wsInstances).toHaveLength(1);
    });
  });

  describe("recovery from a lifecycle suspend has a safety net (cases 5a, 5b, 6)", () => {
    it("5a: a focus catch-up while suspended does not die silently when it fails", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      act(() => {
        window.dispatchEvent(new Event("offline")); // suspends; `online` never follows
      });
      act(() => {
        latestWs().simulateClose(1006); // the deliberate close lands (suspended branch)
      });
      const before = wsInstances.length;
      act(() => {
        window.dispatchEvent(new Event("focus")); // catch-up → connect()
      });
      expect(wsInstances.length).toBe(before + 1);
      // The focus-driven dial fails. It must schedule a retry, not return
      // through the suspended branch and leave nothing running.
      act(() => {
        latestWs().simulateClose(1006);
      });
      const afterFailure = wsInstances.length;
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(wsInstances.length).toBeGreaterThan(afterFailure);
    });

    it("5b: a suspend whose paired recover event never fires is recovered by the watchdog", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      act(() => {
        window.dispatchEvent(new Event("pagehide")); // no pageshow, no online, no resume
      });
      act(() => {
        latestWs().simulateClose(1000);
      });
      const before = wsInstances.length;
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(wsInstances.length).toBeGreaterThan(before);
    });

    it("6: a backoff attempt dropped while hidden is dialed once the tab is visible, even with no visibilitychange", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      act(() => {
        latestWs().simulateClose(1006); // schedules the 1 s backoff
      });
      act(() => {
        setVisibility("hidden", false);
        vi.advanceTimersByTime(1_000); // the timer fires, sees "hidden", drops the attempt
      });
      const before = wsInstances.length;
      expect(before).toBe(1);
      // The platform never delivers `visibilitychange`; the page simply is visible.
      act(() => {
        setVisibility("visible", false);
        vi.advanceTimersByTime(30_000);
      });
      expect(wsInstances.length).toBeGreaterThan(before);
    });

    it("the watchdog stays quiet while the tab is hidden", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      act(() => {
        latestWs().simulateClose(1006);
        setVisibility("hidden");
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(wsInstances).toHaveLength(1);
    });

    it("the watchdog stays quiet while the browser is offline", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      setOnLine(false);
      act(() => {
        window.dispatchEvent(new Event("offline"));
        latestWs().simulateClose(1006);
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(wsInstances).toHaveLength(1);
    });

    it("the watchdog does not double-dial while a socket is in flight or a retry is pending", () => {
      renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        vi.advanceTimersByTime(9_000); // still CONNECTING, under the deadline
      });
      expect(wsInstances).toHaveLength(1);
      act(() => {
        latestWs().simulateClose(1006); // backoff timer now pending
        vi.advanceTimersByTime(500);
      });
      expect(wsInstances).toHaveLength(1);
    });
  });

  describe("offline is its own state", () => {
    it("reports offline from the browser's own signal and reconnects when it ends", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      expect(result.current.isOffline).toBe(false);
      setOnLine(false);
      act(() => {
        window.dispatchEvent(new Event("offline"));
      });
      expect(result.current.isOffline).toBe(true);
      const before = wsInstances.length;
      setOnLine(true);
      act(() => {
        window.dispatchEvent(new Event("online"));
      });
      expect(result.current.isOffline).toBe(false);
      expect(wsInstances.length).toBe(before + 1);
    });

    it("starts offline when the page loads without a network", () => {
      setOnLine(false);
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      expect(result.current.isOffline).toBe(true);
    });
  });

  describe("a refusal the browser can read (client side of case 1)", () => {
    it("close 4429 too_many_connections is reported and retried at the capped interval", () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateOpen(); // the handshake IS accepted…
        latestWs().simulateClose(4429, "too_many_connections"); // …and closed with the reason
      });
      expect(result.current.connectionRejection).toBe("too_many_connections");
      const before = wsInstances.length;
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(wsInstances.length).toBe(before); // not hammered every second
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(wsInstances.length).toBe(before + 1); // …but never given up on
    });

    it("close 4429 rate_limited is reported under its own name", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateClose(4429, "rate_limited");
      });
      expect(result.current.connectionRejection).toBe("rate_limited");
    });

    it("a 4429 without a readable reason is still a rejection, reported as too many connections", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateClose(4429, "");
      });
      expect(result.current.connectionRejection).toBe("too_many_connections");
    });

    it("clears the rejection once a later connection is actually served", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateClose(4429, "too_many_connections");
      });
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      act(() => {
        latestWs().simulateOpen(); // open alone proves nothing: the next 4429 may follow
      });
      expect(result.current.connectionRejection).toBe("too_many_connections");
      act(() => {
        latestWs().simulateMessage({ type: "openclaw_status", connected: true });
      });
      expect(result.current.connectionRejection).toBeNull();
    });

    it("a refused tab does not leave a stale 'connected' flag behind", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "openclaw_status", connected: true });
        latestWs().simulateClose(1006);
      });
      expect(result.current.isOpenClawConnected).toBe(false);
    });
  });

  describe("a connection counts once the server has answered on it", () => {
    function sentChatMessages(ws: MockWebSocket): string[] {
      return ws.send.mock.calls
        .map(([raw]) => JSON.parse(raw as string))
        .filter((frame) => frame.type === "message")
        .map((frame) => frame.content as string);
    }

    function typeMessage(result: { current: ReturnType<typeof useWsRuntime> }, text: string) {
      const runtime = result.current.runtime as unknown as {
        onNew: (message: unknown) => Promise<void>;
      };
      act(() => {
        void runtime.onNew({ content: [{ type: "text", text }], parentId: "root" });
      });
    }

    it("holds a queued message through a refused handshake and sends it on the next served socket", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      typeMessage(result, "Written while connecting");
      const refused = latestWs();
      act(() => {
        refused.simulateOpen(); // the browser says open…
        refused.simulateClose(4429, "too_many_connections"); // …and the server says no
      });
      expect(sentChatMessages(refused)).toEqual([]);

      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      const served = latestWs();
      expect(served).not.toBe(refused);
      act(() => {
        served.simulateOpen();
      });
      expect(sentChatMessages(served)).toEqual([]); // open alone proves nothing
      act(() => {
        served.simulateMessage({ type: "openclaw_status", connected: true });
      });
      expect(sentChatMessages(served)).toEqual(["Written while connecting"]);
    });

    it("an open that closes before the server says anything does not reset the backoff", () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      renderHook(() => useWsRuntime("agent-1"));
      // Three failures in a row: the next delay is 8 s.
      for (let i = 0; i < 3; i++) failAndRedial();
      const before = wsInstances.length;
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateClose(1006);
      });
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(wsInstances.length).toBe(before); // a reset backoff would have redialed after 1 s
    });

    it("a served connection does reset the backoff", () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      renderHook(() => useWsRuntime("agent-1"));
      for (let i = 0; i < 3; i++) failAndRedial();
      const before = wsInstances.length;
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "openclaw_status", connected: true });
        latestWs().simulateClose(1006);
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(wsInstances.length).toBe(before + 1);
    });
  });

  describe("one socket at a time", () => {
    it("a catch-up while the first dial is still connecting does not open a second socket", () => {
      renderHook(() => useWsRuntime("agent-1"));
      expect(wsInstances).toHaveLength(1);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(wsInstances).toHaveLength(1);
    });

    it("a catch-up during a pending backoff leaves the dial to the backoff", () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateClose(1006); // 1 s backoff pending
      });
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(wsInstances).toHaveLength(1);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(wsInstances).toHaveLength(2); // the backoff dials, and only once
    });
  });

  describe("Try again", () => {
    it("redials immediately instead of waiting out the backoff, and restarts the backoff", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      for (let i = 0; i < 6; i++) failAndRedial();
      act(() => {
        latestWs().simulateClose(1006); // 15 s backoff now pending
      });
      const before = wsInstances.length;
      act(() => {
        result.current.retryHistory();
      });
      expect(wsInstances.length).toBe(before + 1);
      // The budget restarted: the next failure waits ~1 s, not 15 s.
      act(() => {
        latestWs().simulateClose(1006);
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(wsInstances.length).toBe(before + 2);
    });

    it("replaces a socket that is open but unusable (upstream down)", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "openclaw_status", connected: false });
      });
      const open = latestWs();
      act(() => {
        result.current.retryHistory();
      });
      expect(open.close).toHaveBeenCalled();
      expect(wsInstances.length).toBe(2);
    });

    it("works out of a suspended state and out of a pending backoff in one press", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      setOnLine(false);
      act(() => {
        window.dispatchEvent(new Event("offline"));
        latestWs().simulateClose(1006);
      });
      setOnLine(true); // the `online` event is the one that went missing
      const before = wsInstances.length;
      act(() => {
        result.current.retryHistory();
      });
      expect(wsInstances.length).toBe(before + 1);
      // …and the new socket is a real, ordinary one: it retries when it fails.
      act(() => {
        latestWs().simulateClose(1006);
      });
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(wsInstances.length).toBeGreaterThan(before + 1);
    });
  });

  describe("the session check is not starved by backoff resets (acceptance 7)", () => {
    it("still asks after N failures in a row although focus and visibility keep resetting the backoff", async () => {
      renderHook(() => useWsRuntime("agent-1"));
      act(() => {
        latestWs().simulateOpen();
      });
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          latestWs().simulateClose(1006);
          await vi.advanceTimersByTimeAsync(0);
        });
        // The user keeps coming back to the tab: that resets the backoff each time.
        await act(async () => {
          setVisibility("hidden");
          setVisibility("visible");
          await vi.advanceTimersByTimeAsync(0);
        });
      }
      expect(mockSessionIsGone).toHaveBeenCalled();
    });

    it("does not ask while the failures are not consecutive", async () => {
      renderHook(() => useWsRuntime("agent-1"));
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          latestWs().simulateOpen(); // each success clears the count
          latestWs().simulateClose(1006);
          await vi.advanceTimersByTimeAsync(2_000);
        });
      }
      expect(mockSessionIsGone).not.toHaveBeenCalled();
    });

    it("counts a CONNECTING timeout as a failed reconnect", async () => {
      renderHook(() => useWsRuntime("agent-1"));
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000); // the dial hangs and is aborted
          await vi.advanceTimersByTimeAsync(15_000); // backoff → next dial
        });
      }
      expect(mockSessionIsGone).toHaveBeenCalled();
    });
  });

  describe("application heartbeat (case 8)", () => {
    function openWithPongSupport() {
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });
      act(() => {
        vi.advanceTimersByTime(25_000);
      });
      act(() => {
        latestWs().simulateMessage({ type: "pong" });
      });
    }

    it("pings an open connection every 25 s", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      expect(latestWs().pings()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(25_000);
      });
      expect(latestWs().send).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }));
    });

    it("never cuts a connection on a server that does not answer pings", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      const ws = latestWs();
      act(() => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      expect(ws.close).not.toHaveBeenCalled();
      expect(wsInstances).toHaveLength(1);
    });

    it("stops pinging a server that never answered the first probe", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      act(() => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      expect(latestWs().pings()).toBe(1);
    });

    it("swallows the 'not configured' error an old server answers an unknown frame with", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      act(() => {
        vi.advanceTimersByTime(25_000);
      });
      act(() => {
        latestWs().simulateMessage({ type: "error", message: "OpenClaw not configured" });
      });
      expect(result.current.hasInlineError).toBe(false);
      expect(result.current.isRunning).toBe(false);
    });

    it("cuts a connection that stops answering once it has proven it can pong", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openWithPongSupport();
      const ws = latestWs();
      act(() => {
        vi.advanceTimersByTime(25_000); // next ping, answered by silence
      });
      expect(ws.pings()).toBe(2);
      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(ws.close).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(ws.close).toHaveBeenCalled();
      // The half-open socket never fires onclose; the chat reconnects anyway.
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expect(wsInstances.length).toBeGreaterThanOrEqual(2);
    });

    it("counts any inbound frame as a sign of life, not only a pong", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openWithPongSupport();
      const ws = latestWs();
      act(() => {
        vi.advanceTimersByTime(25_000);
        vi.advanceTimersByTime(5_000);
        ws.simulateMessage({ type: "openclaw_status", connected: true });
        vi.advanceTimersByTime(24_000);
      });
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("an answered ping keeps the connection for as long as it keeps answering", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openWithPongSupport();
      const ws = latestWs();
      for (let i = 0; i < 6; i++) {
        act(() => {
          vi.advanceTimersByTime(25_000);
        });
        act(() => {
          ws.simulateMessage({ type: "pong" });
        });
      }
      expect(ws.close).not.toHaveBeenCalled();
    });

    it("never shows a pong as a message or an error", () => {
      const { result } = renderHook(() => useWsRuntime("agent-1"));
      openHealthy();
      const before = JSON.stringify(
        (result.current.runtime as unknown as { messages: unknown[] }).messages
      );
      act(() => {
        latestWs().simulateMessage({ type: "pong" });
      });
      expect(
        JSON.stringify((result.current.runtime as unknown as { messages: unknown[] }).messages)
      ).toBe(before);
      expect(result.current.hasInlineError).toBe(false);
    });

    it("does not cut on the first ping of a fresh connection, only once that connection has ponged", () => {
      renderHook(() => useWsRuntime("agent-1"));
      openWithPongSupport();
      act(() => {
        latestWs().simulateClose(1006);
      });
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      act(() => {
        latestWs().simulateOpen();
        latestWs().simulateMessage({ type: "history", messages: [] });
      });
      const fresh = latestWs();
      act(() => {
        vi.advanceTimersByTime(25_000 + 10_000);
      });
      expect(fresh.pings()).toBe(1);
      expect(fresh.close).not.toHaveBeenCalled();
    });
  });
});
