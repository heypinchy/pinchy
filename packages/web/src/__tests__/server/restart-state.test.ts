import { describe, it, expect, vi, beforeEach } from "vitest";

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
});
