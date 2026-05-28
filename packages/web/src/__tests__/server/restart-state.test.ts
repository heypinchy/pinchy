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

  describe("auto-clear safety net", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("auto-clear does NOT fire ready while no OC disconnect has happened since notifyRestart", () => {
      // Production incident 2026-05-28: OC deferred its restart ~3.5 min because
      // active background tasks blocked the channels-block reload. WS stayed
      // connected the entire time. The old 60 s auto-clear used to lie here
      // — it called notifyReady() while OC had not yet even started restarting.
      const listener = vi.fn();
      restartState.on("ready", listener);

      restartState.notifyRestart();
      vi.advanceTimersByTime(60_001);

      expect(restartState.isRestarting).toBe(true);
      expect(listener).not.toHaveBeenCalled();
    });

    it("auto-clears when OC disconnect+reconnect cycle completes", () => {
      // The real signal that OC's restart finished: the WS dropped and then
      // reconnected. server.ts wires notifyDisconnect/notifyConnect into the
      // openclaw-node client events.
      restartState.notifyRestart();
      restartState.notifyDisconnect();
      expect(restartState.isRestarting).toBe(true);

      restartState.notifyConnect();
      expect(restartState.isRestarting).toBe(false);
      expect(restartState.triggeredAt).toBeNull();
    });

    it("notifyConnect without a prior disconnect keeps restarting state (deferred restart)", () => {
      // If OC defers — WS stays up — a stray reconnect signal (e.g. from
      // openclaw-node reconnect-attempt churn) must NOT clear the state. Only
      // a real disconnect-then-reconnect cycle counts.
      restartState.notifyRestart();
      restartState.notifyConnect();

      expect(restartState.isRestarting).toBe(true);
      expect(restartState.triggeredAt).not.toBeNull();
    });

    it("emits 'ready' on disconnect+reconnect cycle", () => {
      const listener = vi.fn();
      restartState.on("ready", listener);

      restartState.notifyRestart();
      restartState.notifyDisconnect();
      restartState.notifyConnect();

      expect(listener).toHaveBeenCalledOnce();
    });

    it("hard-caps at 10 min so a hot-reload-only write cannot strand the overlay", () => {
      // Edge case: OC decides the config change is hot-reloadable and never
      // disconnects. We'd otherwise wait for a disconnect that never comes.
      // After MAX_RESTART_AGE_MS we give up and clear so the overlay closes.
      const listener = vi.fn();
      restartState.on("ready", listener);

      restartState.notifyRestart();
      vi.advanceTimersByTime(60_001);
      expect(listener).not.toHaveBeenCalled();

      // 10 min total since notifyRestart — hard cap fires.
      vi.advanceTimersByTime(10 * 60_000 - 60_001 + 1);
      expect(restartState.isRestarting).toBe(false);
      expect(listener).toHaveBeenCalledOnce();
    });

    it("cancels safety net when notifyReady fires explicitly", () => {
      restartState.notifyRestart();
      vi.advanceTimersByTime(10_000);

      restartState.notifyReady();
      expect(restartState.isRestarting).toBe(false);

      // Advance past the original 10 min hard cap — must not fire a redundant
      // ready event (which would confuse downstream listeners).
      const readyListener = vi.fn();
      restartState.on("ready", readyListener);
      vi.advanceTimersByTime(10 * 60_000);

      expect(readyListener).not.toHaveBeenCalled();
    });

    it("resets the safety window when notifyRestart is called again", () => {
      restartState.notifyRestart();
      vi.advanceTimersByTime(5 * 60_000);

      // A second notifyRestart restarts the hard-cap countdown.
      restartState.notifyRestart();
      vi.advanceTimersByTime(8 * 60_000);

      expect(restartState.isRestarting).toBe(true);

      // 10 min after the SECOND notifyRestart → hard cap.
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(restartState.isRestarting).toBe(false);
    });
  });
});
