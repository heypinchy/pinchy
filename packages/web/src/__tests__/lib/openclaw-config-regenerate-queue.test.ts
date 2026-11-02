import { describe, it, expect } from "vitest";
import {
  _resetRegenerateQueue,
  serializeRegenerates,
  type RegenerateQueueState,
} from "@/lib/openclaw-config/regenerate-queue";

// `regenerateOpenClawConfig` reads the DB, then writes secrets.json and pushes
// openclaw.json. Run concurrently, a slow regenerate that read OLD rows could
// finish after a newer one and win — leaving stale config live, and with
// versioned key slots, openclaw.json and secrets.json on different versions.
// The queue runs one regenerate at a time, and every caller still gets the
// guarantee "the state I changed before calling is applied when my await
// returns". The end-to-end version (real build, real writes) lives in
// openclaw-config.test.ts.

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every queued microtask (and the queue's settle handlers) run. */
async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/**
 * A fake regenerate: each run snapshots the "DB" when it STARTS and blocks
 * until the test releases it, then records what it read as "written".
 */
function harness() {
  const db = { version: 0 };
  const written: number[] = [];
  const gates: ReturnType<typeof deferred>[] = [];
  let started = 0;
  const run = async () => {
    started++;
    const read = db.version;
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    written.push(read);
  };
  const state: RegenerateQueueState = { running: null, rerun: null };
  const regenerate = serializeRegenerates(run, () => state);
  return {
    db,
    written,
    gates,
    regenerate,
    state,
    started: () => started,
  };
}

describe("serializeRegenerates", () => {
  it("starts a run immediately when none is in flight", async () => {
    const h = harness();
    const p = h.regenerate();
    expect(h.started()).toBe(1);
    h.gates[0]!.resolve();
    await p;
    expect(h.written).toEqual([0]);
    expect(h.state).toEqual({ running: null, rerun: null });
  });

  it("never runs two at once: a call during a run waits, and the newer state is written last", async () => {
    const h = harness();
    const first = h.regenerate();

    h.db.version = 1;
    const second = h.regenerate();
    await flush();
    // The second caller's change is NOT read by the run already in flight…
    expect(h.started()).toBe(1);

    h.gates[0]!.resolve();
    await first;
    await flush();
    // …but a run that started after its call picks it up.
    expect(h.started()).toBe(2);
    h.gates[1]!.resolve();
    await second;

    expect(h.written).toEqual([0, 1]);
  });

  it("resolves a waiting caller only after a run that STARTED after its call has completed", async () => {
    const h = harness();
    const first = h.regenerate();
    h.db.version = 1;
    let secondDone = false;
    const second = h.regenerate().then(() => {
      secondDone = true;
    });

    h.gates[0]!.resolve();
    await first;
    await flush();
    // The run that was in flight when the second caller arrived is finished,
    // and that is NOT enough — it read the state from before the call.
    expect(secondDone).toBe(false);

    h.gates[1]!.resolve();
    await second;
    expect(secondDone).toBe(true);
    expect(h.written.at(-1)).toBe(1);
  });

  it("coalesces every call made during a run into exactly one rerun", async () => {
    const h = harness();
    const first = h.regenerate();
    h.db.version = 3;
    const waiting = [h.regenerate(), h.regenerate(), h.regenerate()];

    h.gates[0]!.resolve();
    await first;
    await flush();
    expect(h.started()).toBe(2);

    h.gates[1]!.resolve();
    await Promise.all(waiting);
    await flush();
    expect(h.started()).toBe(2);
    expect(h.written).toEqual([0, 3]);
    expect(h.state).toEqual({ running: null, rerun: null });
  });

  it("queues a call made during the rerun behind it, rather than joining it", async () => {
    const h = harness();
    const first = h.regenerate();
    const second = h.regenerate();
    h.gates[0]!.resolve();
    await first;
    await flush();
    expect(h.started()).toBe(2);

    // The rerun is now in flight and has already read version 0.
    h.db.version = 7;
    const third = h.regenerate();
    h.gates[1]!.resolve();
    await second;
    await flush();
    expect(h.started()).toBe(3);
    h.gates[2]!.resolve();
    await third;

    expect(h.written).toEqual([0, 0, 7]);
  });

  it("rejects only the callers whose run failed", async () => {
    const h = harness();
    const first = h.regenerate();
    const second = h.regenerate();

    h.gates[0]!.reject(new Error("first run failed"));
    await expect(first).rejects.toThrow("first run failed");
    await flush();

    // A failure does not wedge the queue: the rerun still happens, and its
    // caller hears its own outcome.
    expect(h.started()).toBe(2);
    h.gates[1]!.resolve();
    await expect(second).resolves.toBeUndefined();
  });

  it("delivers a failed rerun to the callers that waited for it, not to the earlier caller", async () => {
    const h = harness();
    const first = h.regenerate();
    const second = h.regenerate();
    const third = h.regenerate();

    h.gates[0]!.resolve();
    await expect(first).resolves.toBeUndefined();
    await flush();
    h.gates[1]!.reject(new Error("rerun failed"));

    await expect(second).rejects.toThrow("rerun failed");
    await expect(third).rejects.toThrow("rerun failed");
    expect(h.state).toEqual({ running: null, rerun: null });
  });

  it("propagates a synchronous throw from the run as a rejection, and keeps the queue usable", async () => {
    const state: RegenerateQueueState = { running: null, rerun: null };
    let calls = 0;
    const regenerate = serializeRegenerates(
      () => {
        calls++;
        if (calls === 1) throw new Error("sync boom");
        return Promise.resolve();
      },
      () => state
    );

    await expect(regenerate()).rejects.toThrow("sync boom");
    await expect(regenerate()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("_resetRegenerateQueue lets the next regenerate start while an abandoned run is still held", async () => {
    _resetRegenerateQueue();
    const held = deferred();
    let runs = 0;
    // Production state (globalThis), not an injected one: that is what the
    // reset is for.
    const regenerate = serializeRegenerates(() => {
      runs++;
      return runs === 1 ? held.promise : Promise.resolve();
    });

    void regenerate();
    expect(runs).toBe(1);

    _resetRegenerateQueue();
    await regenerate();
    expect(runs).toBe(2);

    // The abandoned run settling late must not touch the fresh queue.
    held.resolve();
    await flush();
    expect(globalThis.__pinchyRegenerateQueue).toEqual({ running: null, rerun: null });
    expect(runs).toBe(2);
  });
});
