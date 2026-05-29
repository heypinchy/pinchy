import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let restartState: typeof import("@/server/restart-state").restartState;

describe("restartState", () => {
  beforeEach(async () => {
    // Clear the singleton so each test starts fresh
    const key = Symbol.for("pinchy.restartState");
    delete (globalThis as Record<symbol, unknown>)[key];

    // Re-import to get a fresh instance
    vi.resetModules();
    const mod = await import("@/server/restart-state");
    restartState = mod.restartState;
  });

  it("starts in non-restarting state", () => {
    expect(restartState.isRestarting).toBe(false);
    expect(restartState.triggeredAt).toBeNull();
  });

  it("notifyRestart sets isRestarting to true and records timestamp", () => {
    const before = Date.now();
    restartState.notifyRestart();
    const after = Date.now();

    expect(restartState.isRestarting).toBe(true);
    expect(restartState.triggeredAt).toBeGreaterThanOrEqual(before);
    expect(restartState.triggeredAt).toBeLessThanOrEqual(after);
  });

  it("notifyReady resets state", () => {
    restartState.notifyRestart();
    restartState.notifyReady();

    expect(restartState.isRestarting).toBe(false);
    expect(restartState.triggeredAt).toBeNull();
  });

  it("emits 'restarting' event on notifyRestart", () => {
    const listener = vi.fn();
    restartState.on("restarting", listener);

    restartState.notifyRestart();

    expect(listener).toHaveBeenCalledOnce();
  });

  it("emits 'ready' event on notifyReady", () => {
    const listener = vi.fn();
    restartState.on("ready", listener);

    restartState.notifyRestart();
    restartState.notifyReady();

    expect(listener).toHaveBeenCalledOnce();
  });

  it("is idempotent — multiple notifyRestart calls are safe", () => {
    const listener = vi.fn();
    restartState.on("restarting", listener);

    restartState.notifyRestart();
    const firstTimestamp = restartState.triggeredAt;

    restartState.notifyRestart();

    expect(restartState.isRestarting).toBe(true);
    // Timestamp should update on each call
    expect(restartState.triggeredAt).toBeGreaterThanOrEqual(firstTimestamp!);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("notifyReady is safe when not restarting", () => {
    const listener = vi.fn();
    restartState.on("ready", listener);

    restartState.notifyReady();

    expect(restartState.isRestarting).toBe(false);
    // Should not emit if already not restarting
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns singleton across imports", async () => {
    restartState.notifyRestart();

    const mod2 = await import("@/server/restart-state");
    expect(mod2.restartState.isRestarting).toBe(true);
  });

  describe("notifyDisconnect — deferred-restart re-fire", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-fires notifyRestart when OC disconnects shortly after a completed restart", () => {
      // Scenario: config write → notifyRestart → OC reconnects (notifyReady) →
      // OC defers the real restart for active runs → OC disconnects 2 min later
      // → notifyDisconnect must re-show the overlay.
      const restartingListener = vi.fn();
      restartState.on("restarting", restartingListener);

      restartState.notifyRestart(); // config saved, overlay shown
      restartState.notifyReady(); // OC reconnected (pre-restart handshake)
      expect(restartState.isRestarting).toBe(false);

      // Advance 2 min — still within the deferred window
      vi.advanceTimersByTime(2 * 60_000);

      restartState.notifyDisconnect(); // OC actually goes down for its restart

      expect(restartState.isRestarting).toBe(true);
      expect(restartingListener).toHaveBeenCalledTimes(2); // once for original, once for re-fire
    });

    it("is a no-op when isRestarting is already true (overlay already visible)", () => {
      const restartingListener = vi.fn();
      restartState.on("restarting", restartingListener);

      restartState.notifyRestart();
      expect(restartState.isRestarting).toBe(true);

      restartState.notifyDisconnect();

      // Should not have fired a second restarting event
      expect(restartingListener).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when disconnect happens after the deferred window expires", () => {
      // DEFERRED_RESTART_WINDOW_MS = 10 min; a disconnect >10 min after the
      // last trigger is unrelated to the original restart.
      restartState.notifyRestart();
      restartState.notifyReady();

      vi.advanceTimersByTime(11 * 60_000); // past the window

      restartState.notifyDisconnect();

      expect(restartState.isRestarting).toBe(false);
    });

    it("is a no-op when notifyRestart was never called", () => {
      restartState.notifyDisconnect();
      expect(restartState.isRestarting).toBe(false);
    });

    it("emits 'restarting' on re-fire so the WS broadcaster shows the overlay", () => {
      const listener = vi.fn();
      restartState.on("restarting", listener);

      restartState.notifyRestart();
      restartState.notifyReady();
      vi.advanceTimersByTime(60_000);

      restartState.notifyDisconnect();

      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe("auto-clear safety net", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("auto-clears isRestarting after 60s if notifyReady never arrives", () => {
      // notifyRestart assumes a corresponding OC restart will fire notifyReady
      // via server.ts's reconnect handler. But OC may treat the file change as
      // a no-op (e.g., byte diff but no functional diff) and never restart —
      // in which case isRestarting would stay true forever, blocking the UI
      // overlay and any test polling /api/health/openclaw for status="ok".
      restartState.notifyRestart();
      expect(restartState.isRestarting).toBe(true);
      expect(restartState.triggeredAt).not.toBeNull();

      vi.advanceTimersByTime(59_999);
      expect(restartState.isRestarting).toBe(true);

      vi.advanceTimersByTime(2);
      expect(restartState.isRestarting).toBe(false);
      // Auto-clear must take the full notifyReady() path — both flags reset —
      // so any future caller relying on `triggeredAt == null` as the
      // "not restarting" tell sees consistent state.
      expect(restartState.triggeredAt).toBeNull();
    });

    it("emits 'ready' when auto-clear fires", () => {
      const listener = vi.fn();
      restartState.on("ready", listener);

      restartState.notifyRestart();
      vi.advanceTimersByTime(60_001);

      expect(listener).toHaveBeenCalledOnce();
    });

    it("cancels auto-clear when notifyReady fires first", () => {
      restartState.notifyRestart();
      vi.advanceTimersByTime(10_000);

      restartState.notifyReady();
      expect(restartState.isRestarting).toBe(false);

      // Advance past the original 60s — auto-clear must not fire a redundant
      // ready event (which would confuse the WS broadcaster).
      const readyListener = vi.fn();
      restartState.on("ready", readyListener);
      vi.advanceTimersByTime(60_000);

      expect(readyListener).not.toHaveBeenCalled();
    });

    it("resets the 60s window when notifyRestart is called again", () => {
      restartState.notifyRestart();
      vi.advanceTimersByTime(50_000);

      // A second notifyRestart (e.g., another channel mutation) restarts the
      // safety-net countdown — don't auto-clear 10s after the second call.
      restartState.notifyRestart();
      vi.advanceTimersByTime(20_000);

      expect(restartState.isRestarting).toBe(true);

      vi.advanceTimersByTime(40_001);
      expect(restartState.isRestarting).toBe(false);
    });
  });
});
