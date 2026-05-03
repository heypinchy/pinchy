import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";
import { useChatStatus } from "../use-chat-status";

const base = {
  isConnected: true,
  isOpenClawConnected: true,
  isHistoryLoaded: true,
  hasInitialContent: true,
  isRunning: false,
  reconnectExhausted: false,
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

  it("returns 'unavailable' with reason 'exhausted' when reconnect gave up", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, reconnectExhausted: true }));
    expect(result.current).toEqual({ kind: "unavailable", reason: "exhausted" });
  });

  it("priority: exhausted > configuring > disconnected > starting > responding > ready", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        reconnectExhausted: true,
        configuring: true,
        isConnected: false,
        isHistoryLoaded: false,
        isRunning: true,
      })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "exhausted" });
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
    expect(result.current).toEqual({ kind: "unavailable", reason: "disconnected" });
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

  it("transitions immediately for reason 'exhausted'", () => {
    const { result, rerender } = renderHook(({ inputs }) => useChatStatus(inputs), {
      initialProps: { inputs: base },
    });
    rerender({ inputs: { ...base, reconnectExhausted: true } });
    expect(result.current).toEqual({ kind: "unavailable", reason: "exhausted" });
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
 *   unavailable/disconnected — WebSocket dropped unexpectedly. 2s hysteresis suppresses
 *                              the red dot during brief reconnects.
 *
 *   unavailable/exhausted    — Reconnect gave up after max attempts. User must reload.
 *
 * Priority (highest → lowest):
 *   exhausted > configuring > disconnected > starting > responding > ready
 */
describe("state machine documentation — complete output mapping", () => {
  it("exhausted=true → unavailable/exhausted (highest priority, ignores all other flags)", () => {
    const { result } = renderHook(() =>
      useChatStatus({
        ...base,
        reconnectExhausted: true,
        configuring: true,
        isConnected: false,
        isHistoryLoaded: false,
        isRunning: true,
      })
    );
    expect(result.current).toEqual({ kind: "unavailable", reason: "exhausted" });
  });

  it("configuring=true, not exhausted → unavailable/configuring", () => {
    const { result } = renderHook(() => useChatStatus({ ...base, configuring: true }));
    expect(result.current).toEqual({ kind: "unavailable", reason: "configuring" });
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
