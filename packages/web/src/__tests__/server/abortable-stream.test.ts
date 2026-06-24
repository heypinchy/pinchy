import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { iterateUntilAborted } from "@/server/abortable-stream";
import { OpenClawDisconnectSignal } from "@/server/openclaw-disconnect-signal";

const never = () => new Promise<void>(() => {});

describe("iterateUntilAborted", () => {
  it("yields every value when the abort promise never resolves", async () => {
    const source = (async function* () {
      yield 1;
      yield 2;
      yield 3;
    })();
    const out: number[] = [];
    for await (const v of iterateUntilAborted(source, never())) out.push(v);
    expect(out).toEqual([1, 2, 3]);
  });

  it("stops early and invokes onAbort when abort wins the race for the next value", async () => {
    let releaseAbort!: () => void;
    const aborted = new Promise<void>((r) => {
      releaseAbort = r;
    });
    // A source that produces one value then blocks forever — the shape of
    // openclaw-node's chat() generator after the OC socket drops mid-stream.
    const source = (async function* () {
      yield "first";
      await never();
      yield "never-reached";
    })();

    let onAbortCalled = false;
    const gen = iterateUntilAborted(source, aborted, () => {
      onAbortCalled = true;
    });

    const first = await gen.next();
    expect(first.value).toBe("first");

    // The source is now blocked; firing abort must terminate the iteration.
    releaseAbort();
    const second = await gen.next();
    expect(second.done).toBe(true);
    expect(onAbortCalled).toBe(true);
  });

  it("does not call onAbort when the source ends naturally", async () => {
    const source = (async function* () {
      yield 1;
    })();
    let onAbortCalled = false;
    const out: number[] = [];
    for await (const v of iterateUntilAborted(source, never(), () => {
      onAbortCalled = true;
    })) {
      out.push(v);
    }
    expect(out).toEqual([1]);
    expect(onAbortCalled).toBe(false);
  });
});

describe("OpenClawDisconnectSignal", () => {
  it("resolves whenDisconnected() on the next 'disconnected' event", async () => {
    const client = new EventEmitter();
    const signal = new OpenClawDisconnectSignal(client);
    let resolved = false;
    void signal.whenDisconnected().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    client.emit("disconnected");
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("re-arms on reconnect so a run started after the outage gets a live (unfired) signal", async () => {
    const client = new EventEmitter();
    const signal = new OpenClawDisconnectSignal(client);

    // First outage fires the initial epoch.
    client.emit("disconnected");
    // OpenClaw comes back — arm a fresh promise for the next run.
    client.emit("connected");

    let resolved = false;
    void signal.whenDisconnected().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // the new epoch has NOT fired yet

    client.emit("disconnected");
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("registers exactly one listener per event no matter how many runs await it", () => {
    // The whole point of the shared signal: a flat listener count on the
    // OpenClaw client regardless of concurrent in-flight runs (no per-run
    // subscribe/unsubscribe churn, no MaxListenersExceededWarning).
    const client = new EventEmitter();
    const signal = new OpenClawDisconnectSignal(client);
    // Many concurrent callers share the same promise.
    signal.whenDisconnected();
    signal.whenDisconnected();
    signal.whenDisconnected();
    expect(client.listenerCount("disconnected")).toBe(1);
    expect(client.listenerCount("connected")).toBe(1);
  });
});
