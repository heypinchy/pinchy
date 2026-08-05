import { describe, it, expect } from "vitest";
import { runWithConcurrency } from "@/lib/concurrency";

describe("runWithConcurrency", () => {
  it("never runs more than the given concurrency limit at once", async () => {
    let active = 0;
    let maxActive = 0;

    const tasks = Array.from({ length: 20 }, (_, i) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield without a real timer so every task gets a chance to overlap if
      // the limiter isn't actually bounding concurrency.
      await Promise.resolve();
      await Promise.resolve();
      active--;
      return i;
    });

    await runWithConcurrency(tasks, 5);

    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it("preserves result order regardless of completion order", async () => {
    const tasks = [3, 1, 2].map(
      (delay, i) => () => new Promise<number>((resolve) => setTimeout(() => resolve(i), delay))
    );

    const results = await runWithConcurrency(tasks, 3);

    expect(results).toEqual([0, 1, 2]);
  });

  it("runs every task even when concurrency exceeds the task count", async () => {
    const calls: number[] = [];
    const tasks = [0, 1, 2].map((i) => async () => {
      calls.push(i);
      return i;
    });

    const results = await runWithConcurrency(tasks, 10);

    expect(calls.sort()).toEqual([0, 1, 2]);
    expect(results).toEqual([0, 1, 2]);
  });

  it("resolves to an empty array for an empty task list", async () => {
    const results = await runWithConcurrency([], 5);
    expect(results).toEqual([]);
  });

  // A worker pool sized `Math.min(concurrency, tasks.length)` spawns zero
  // workers for a non-positive limit, so every task is skipped and the caller
  // gets back a sparse array of undefined — silent data loss rather than an
  // error. Today's call sites pass constants, but this is a shared helper now.
  it.each([0, -1])("still runs every task when the limit is %i", async (limit) => {
    const calls: number[] = [];
    const tasks = [0, 1, 2].map((i) => async () => {
      calls.push(i);
      return i;
    });

    const results = await runWithConcurrency(tasks, limit);

    expect(calls).toHaveLength(3);
    expect(results).toEqual([0, 1, 2]);
  });
});
