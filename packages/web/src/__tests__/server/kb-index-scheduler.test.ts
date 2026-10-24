/**
 * The scheduler's process lifecycle: the interval it runs on and what a broken
 * tick does to it. What a tick DECIDES is covered against a real database in
 * kb-index-scheduler.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetIndexSchedule = vi.fn();
vi.mock("@/lib/knowledge/index-schedule-store", () => ({
  getIndexSchedule: () => mockGetIndexSchedule(),
  getIndexScheduleState: vi.fn(),
  saveIndexScheduleState: vi.fn(),
}));
vi.mock("@/lib/settings-timezone", () => ({ getOrgTimezone: async () => "UTC" }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/audit", () => ({ appendAuditLog: vi.fn(), safeProviderError: (s: string) => s }));
vi.mock("@/lib/audit-deferred", () => ({ recordAuditFailure: vi.fn() }));

const {
  runKbIndexSchedulerTick,
  startKbIndexScheduler,
  stopKbIndexScheduler,
  _isKbIndexSchedulerRunning,
  _resetKbIndexSchedulerForTest,
} = await import("@/server/kb-index-scheduler");

beforeEach(() => {
  vi.useFakeTimers();
  _resetKbIndexSchedulerForTest();
  mockGetIndexSchedule.mockReset();
});

afterEach(() => {
  stopKbIndexScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("kb index scheduler lifecycle", () => {
  it("runs until it is stopped", () => {
    expect(_isKbIndexSchedulerRunning()).toBe(false);
    startKbIndexScheduler();
    expect(_isKbIndexSchedulerRunning()).toBe(true);
    stopKbIndexScheduler();
    expect(_isKbIndexSchedulerRunning()).toBe(false);
  });

  it("looks at the clock once a minute", async () => {
    mockGetIndexSchedule.mockRejectedValue(new Error("stop here"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    startKbIndexScheduler();

    await vi.advanceTimersByTimeAsync(59_000);
    expect(mockGetIndexSchedule).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockGetIndexSchedule).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockGetIndexSchedule).toHaveBeenCalledTimes(2);
  });

  // A database blip at 02:00 must cost one tick, not the scheduler: the next
  // minute tries again, and the slot is still due.
  it("logs a failed tick instead of throwing, and keeps ticking", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetIndexSchedule.mockRejectedValueOnce(new Error("connection reset"));

    await expect(runKbIndexSchedulerTick()).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[kb-index-scheduler] tick failed:",
      expect.objectContaining({ message: "connection reset" })
    );
  });
});
