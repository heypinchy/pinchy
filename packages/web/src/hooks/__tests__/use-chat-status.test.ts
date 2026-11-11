// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { type ChatStatusInputs, useChatStatus } from "../use-chat-status";

const base: ChatStatusInputs = {
  isConnected: true,
  isOpenClawConnected: true,
  isHistoryLoaded: true,
  hasInitialContent: true,
  isRunning: false,
  isOffline: false,
  connectionRejection: null,
  payloadRejected: false,
  historyTimedOut: false,
  configuring: false,
};

describe("useChatStatus", () => {
  it("returns 'starting' before history is loaded", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, isHistoryLoaded: false }));
    expect(result.current).toEqual({ kind: "starting" });
  });

  it("returns 'ready' when fully connected, history loaded, idle", () => {
    const { result } = renderHook(() => useChatStatus(base));
    expect(result.current).toEqual({ kind: "ready" });
  });

  it("returns 'starting' when history is loaded but no content is renderable yet", () => {
    // Issue #197: keep 'starting' shown until the initial message actually
    // appears on screen. Server has responded (`isHistoryLoaded`), but the
    // greeting/history messages haven't been committed to local state yet.
    const { result } = renderHook(() =>
      useChatStatus({ ...base, isHistoryLoaded: true, hasInitialContent: false })
    );
    expect(result.current).toEqual({ kind: "starting" });
  });

  it("returns 'ready' when history is loaded and content is renderable", () => {
    const { result } = renderHook(() =>
      useChatStatus({ ...base, isHistoryLoaded: true, hasInitialContent: true })
    );
    expect(result.current).toEqual({ kind: "ready" });
  });

  it("returns 'responding' when running", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, isRunning: true }));
    expect(result.current).toEqual({ kind: "responding" });
  });

  it("returns 'unavailable' with reason 'configuring' when configuring", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, configuring: true }));
    expect(result.current).toEqual({ kind: "unavailable", reason: "configuring" });
  });

  it("returns 'unavailable' with reason 'offline' when the browser has no network", () => {
    const { result } = renderHook(() =>
      useChatStatus({ ...base, isConnected: false, isOffline: true })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("returns 'unavailable' with reason 'rejected' when the server refused the connection", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isConnected: false,
        isOpenClawConnected: false,
        connectionRejection: "too_many_connections",
      })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "rejected" });
  });

  it("returns 'payloadRejected' immediately when the last send was too large", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isConnected: false,
        isHistoryLoaded: false,
        payloadRejected: true,
      })
    );
    expect(result.current).toEqual({ kind: "payloadRejected" });
  });

  it("returns 'unavailable' with reason 'historyTimeout' when the initial history never arrived", () => {
    // Issue #956: the wait for the first history frame has a deadline. Once it
    // expires with nothing renderable on screen, the chat must stop pretending
    // to start and offer a way out instead.
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isHistoryLoaded: false,
        hasInitialContent: false,
        historyTimedOut: true,
      })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "historyTimeout" });
  });

  it("ignores a history timeout once there is content on screen", () => {
    // A catch-up re-pull can time out mid-conversation. The transcript is still
    // there, so the chat is not in a dead end — don't blank it with an error.
    const { result } = renderHook(() =>
      useChatStatus({ ...base, historyTimedOut: true, hasInitialContent: true })
    );
    expect(result.current).toEqual({ kind: "ready" });
  });

  it("prefers the history timeout over the generic 'disconnected' state", () => {
    // The self-heal closes the socket, so isConnected drops right after the
    // deadline. "Reconnecting..." would hide the retry the user needs.
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isConnected: false,
        isHistoryLoaded: false,
        hasInitialContent: false,
        historyTimedOut: true,
      })
    );
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "historyTimeout" });
    vi.useRealTimers();
  });

  it("priority: offline > rejected > configuring > payloadRejected > historyTimeout > disconnected > starting > responding > ready", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isOffline: true,
        connectionRejection: "rate_limited",
        configuring: true,
        payloadRejected: true,
        historyTimedOut: true,
        hasInitialContent: false,
        isConnected: false,
        isHistoryLoaded: false,
        isRunning: true,
      })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("rejected outranks configuring and a payload rejection", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        connectionRejection: "too_many_connections",
        configuring: true,
        payloadRejected: true,
      })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "rejected" });
  });
});

describe("hysteresis", () => {
  afterEach(() => vi.useRealTimers());

  it("shows 'starting' (not 'disconnected') on cold-start mount before WS opens", () => {
    // Cold-start: WS hasn't connected yet (isConnected=false), no history yet.
    // The hysteresis must apply to the initial mount too — showing 'disconnected'
    // immediately on first render is wrong because no connection has even been
    // attempted from the user's perspective.
    const { result } = renderHook(() =>
      useChatStatus({ ...base, isConnected: false, isHistoryLoaded: false })
    );
    expect(result.current).toEqual({ kind: "starting" });
  });

  it("transitions cold-start mount to 'disconnected' after 2s if WS never opens", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useChatStatus({ ...base, isConnected: false, isHistoryLoaded: false })
    );
    expect(result.current).toEqual({ kind: "starting" });

    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "disconnected" });
  });

  it("delays 'disconnected' transition by 2s after fullyConnected drops", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: base },
    });
    expect(result.current.kind).toBe("ready");

    rerender({ inputs: { ...base, isOpenClawConnected: false } });
    expect(result.current.kind).toBe("ready");

    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(result.current.kind).toBe("ready");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    // The socket is open, only the upstream dropped: its own reason now.
    expect(result.current).toEqual({ kind: "unavailable", reason: "upstreamDown" });
  });

  it("cancels the pending disconnect when fullyConnected returns within 2s", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: base },
    });
    rerender({ inputs: { ...base, isOpenClawConnected: false } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ inputs: base });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.kind).toBe("ready");
  });

  it("transitions immediately for reason 'configuring' (no hysteresis)", () => {
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: base },
    });
    rerender({ inputs: { ...base, configuring: true } });
    expect(result.current).toEqual({ kind: "unavailable", reason: "configuring" });
  });

  it("transitions immediately for reason 'offline' (the browser said so, no hysteresis)", () => {
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: base },
    });
    rerender({ inputs: { ...base, isConnected: false, isOffline: true } });
    expect(result.current).toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("transitions immediately for reason 'rejected' (the server said so, no hysteresis)", () => {
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: base },
    });
    rerender({
      inputs: { ...base, isConnected: false, connectionRejection: "rate_limited" as const },
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "rejected" });
  });

  it("reports an open socket whose upstream is down as 'upstreamDown', after the hysteresis", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatStatus({ ...base, isOpenClawConnected: false }));
    expect(result.current.kind).toBe("ready"); // a blip is not shown: no flash
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "upstreamDown" });
  });

  it("keeps payload rejection from becoming disconnected after the hysteresis delay", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isConnected: false,
        isHistoryLoaded: false,
        payloadRejected: true,
      })
    );

    act(() => {
      vi.advanceTimersByTime(2100);
    });

    expect(result.current).toEqual({ kind: "payloadRejected" });
  });
});

describe("escalation after 30 s of continuous unavailability (#1422)", () => {
  afterEach(() => vi.useRealTimers());
  const down = { ...base, isConnected: false, isOpenClawConnected: false };

  it("says 'disconnected' (still retrying) before 30 s and 'unreachable' after", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatStatus(down));
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "disconnected" });
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "unreachable" });
  });

  it("is not reset by a flap: an open socket that is not served does not restart the clock", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: down },
    });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    rerender({ inputs: { ...down, isConnected: true } }); // handshake accepted, nothing served
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender({ inputs: down });
    act(() => {
      vi.advanceTimersByTime(5_100);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "unreachable" });
  });

  it("is cleared the moment the chat is fully connected again", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: down },
    });
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "unreachable" });
    rerender({ inputs: base });
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current).toEqual({ kind: "ready" });
    // …and a new outage starts a new clock.
    rerender({ inputs: down });
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "disconnected" });
  });

  it("marks an upstream outage that outlived the deadline, so the UI can offer a bug report", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useChatStatus({ ...base, isOpenClawConnected: false }));
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(result.current).toEqual({
      kind: "unavailable",
      reason: "upstreamDown",
      escalated: true,
    });
  });

  it("does not count time spent offline or configuring as an outage worth escalating", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: { ...down, isOffline: true } },
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "offline" });
    rerender({ inputs: down }); // back online, server still down: fresh clock
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(result.current).toEqual({ kind: "unavailable", reason: "disconnected" });
  });
});

/**
 * State machine documentation — complete output mapping.
 *
 * This describe block acts as executable documentation for the status state
 * machine after the cold-start architecture changes (Phases 1-5, 2026-05-03).
 *
 * Architecture context after Phase 4.2:
 *   - Pinchy starts first, writes openclaw.json, calls markOpenClawConfigReady()
 *   - OpenClaw starts ONLY AFTER the Pinchy healthcheck passes
 *   - WebSocket connects immediately on first boot (no restart cascade)
 *   - `starting` is now brief (WS connecting + history loading, not a cascade)
 *
 * All six states remain valid after Phase 1-5:
 *
 *   starting           — WS not yet connected OR history/content not yet loaded.
 *                        After Phase 4.2 this is brief: OpenClaw is already fully
 *                        up before Pinchy opens the WS connection.
 *
 *   ready              — Fully connected, history and content loaded, agent idle.
 *
 *   responding         — Agent is currently processing a request.
 *
 *   unavailable/configuring  — Admin saved agent settings; `regenerateOpenClawConfig()`
 *                              ran; OpenClaw detected the file change and sent SIGUSR1.
 *                              Shows "Applying changes…" during the ~10s restart window.
 *                              Triggered by user action post-boot, not by cold-start.
 *
 *   payloadRejected           — Server rejected the last WebSocket frame as too large.
 *
 *   unavailable/disconnected — WebSocket dropped unexpectedly. 2s hysteresis suppresses
 *                              the red dot during brief reconnects.
 *
 *   unavailable/offline      — The browser has no network. Reconnects as soon as it returns.
 *   unavailable/rejected     — The server refused the connection (4429); retried at a capped interval.
 *   unavailable/upstreamDown — Socket open, the agent runtime behind it is not.
 *   unavailable/unreachable  — Disconnected for 30 s: same retrying, louder message.
 *
 * Priority (highest → lowest):
 *   offline > rejected > configuring > payloadRejected > historyTimeout > disconnected > starting > responding > ready
 */
describe("state machine documentation — complete output mapping", () => {
  it("offline=true → unavailable/offline (highest priority, ignores all other flags)", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isOffline: true,
        configuring: true,
        isConnected: false,
        isHistoryLoaded: false,
        isRunning: true,
      })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("configuring=true, not offline → unavailable/configuring", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, configuring: true }));
    expect(result.current).toEqual({ kind: "unavailable", reason: "configuring" });
  });

  it("payloadRejected=true, not offline/configuring → payloadRejected", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        isConnected: false,
        payloadRejected: true,
      })
    );
    expect(result.current).toEqual({ kind: "payloadRejected" });
  });

  it("history not loaded → starting", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, isHistoryLoaded: false }));
    expect(result.current).toEqual({ kind: "starting" });
  });

  it("no initial content yet → starting", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, hasInitialContent: false }));
    expect(result.current).toEqual({ kind: "starting" });
  });

  it("running → responding", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, isRunning: true }));
    expect(result.current).toEqual({ kind: "responding" });
  });

  it("all nominal → ready", () => {
    const { result } = renderHook(() => useChatStatus(base));
    expect(result.current).toEqual({ kind: "ready" });
  });

  it("cold-start sequence: starting → ready (no red-dot oscillation)", () => {
    // Simulates the post-Phase-4.2 cold-start path:
    //   mount (WS not yet open, no history) → WS connects → history loads → ready
    // The indicator must stay yellow/starting throughout; it must never flash red.
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: {
        inputs: {
          ...base,
          isConnected: false,
          isOpenClawConnected: false,
          isHistoryLoaded: false,
          hasInitialContent: false,
        },
      },
    });

    // T=0: WS not open yet — must show starting, not disconnected
    expect(result.current).toEqual({ kind: "starting" });

    // T=1: WebSocket connected, OpenClaw connected, but history still loading
    rerender({ inputs: { ...base, isHistoryLoaded: false, hasInitialContent: false } });
    expect(result.current).toEqual({ kind: "starting" });

    // T=2: History loaded but content not yet rendered
    rerender({ inputs: { ...base, isHistoryLoaded: true, hasInitialContent: false } });
    expect(result.current).toEqual({ kind: "starting" });

    // T=3: Content rendered — transition to ready
    rerender({ inputs: { ...base, isHistoryLoaded: true, hasInitialContent: true } });
    expect(result.current).toEqual({ kind: "ready" });
  });
});
