// Unit tests for the Inbox Agent reconciliation-sweep scheduler (Brick E).
//
// This is the in-process cadence that makes the sweep autonomous, mirroring the
// established periodic-job pattern (`upload-gc.ts`, `audit-verify-job.ts`): a
// `setInterval` plus a post-startup kick, each firing a re-entrancy-guarded run.
//
// The load-bearing new logic is the guard: the sweep re-lists a whole window and
// hits provider rate limits, so a tick that fires while the previous sweep is
// still in flight must be *skipped*, never run concurrently. The ledger already
// makes overlap correct (atomic claim), but not free — so the guard is what stops
// a slow pass from stacking redundant provider I/O on top of itself.
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  createGuardedSweepRunner,
  startInboxSweep,
  stopInboxSweep,
  _isInboxSweepRunning,
  SWEEP_STARTUP_DELAY_MS,
  SWEEP_INTERVAL_MS,
} from "@/server/inbox-sweep";

describe("inbox sweep — re-entrancy guard", () => {
  it("does not start a second sweep while one is already in flight", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = createGuardedSweepRunner(async () => {
      calls++;
      await gate; // stay in-flight until the test releases it
    });

    const first = run(); // sweep #1 starts and parks on the gate
    const second = run(); // must be skipped — no concurrent sweep

    expect(calls).toBe(1);

    release();
    await Promise.all([first, second]);

    // Once the in-flight sweep has finished, a later tick runs a fresh sweep.
    await run();
    expect(calls).toBe(2);
  });

  it("isolates a throwing sweep: logs it, never rejects, and frees the guard for the next tick", async () => {
    // The interval fires the runner as `void run()`, so a rejection would surface
    // as an unhandled process-level rejection. A throw must also not leave the
    // guard stuck `inFlight` — that would silently wedge every future sweep, the
    // worst failure for a component whose whole job is "never lose an email".
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args.map(String).join(" "));
    });
    let calls = 0;
    const run = createGuardedSweepRunner(async () => {
      calls++;
      throw new Error("boom");
    });

    try {
      await expect(run()).resolves.toBeUndefined();
      expect(logged.some((line) => line.includes("boom"))).toBe(true);

      // The guard was freed despite the throw — the next tick runs a fresh sweep.
      await run();
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("inbox sweep — scheduler wiring", () => {
  afterEach(() => {
    stopInboxSweep();
    vi.useRealTimers();
  });

  it("_isInboxSweepRunning reflects start/stop", () => {
    expect(_isInboxSweepRunning()).toBe(false);
    startInboxSweep(async () => {});
    expect(_isInboxSweepRunning()).toBe(true);
    stopInboxSweep();
    expect(_isInboxSweepRunning()).toBe(false);
  });

  it("fires the sweep on a post-startup kick and then on the interval, and stops cleanly", async () => {
    // Mirrors upload-gc/audit-verify-job: nothing fires synchronously on start;
    // a delayed kick runs the first pass (after the gateway/config settle), then
    // the interval drives the cadence. stop() must clear both timers so a stopped
    // scheduler never fires again — a leaked interval is exactly the timer leak
    // the enterprise-banner flake taught us to guard against.
    vi.useFakeTimers();
    let calls = 0;
    startInboxSweep(async () => {
      calls++;
    });

    expect(calls).toBe(0); // nothing runs immediately

    await vi.advanceTimersByTimeAsync(SWEEP_STARTUP_DELAY_MS);
    expect(calls).toBe(1); // the post-startup kick

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(calls).toBe(2); // the recurring interval

    stopInboxSweep();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
    expect(calls).toBe(2); // no further passes after stop
  });
});
