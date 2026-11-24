// Unit test for the setup-race helpers in e2e/shared/poll-until.ts, used by
// e2e/integration/global-setup.ts. The injected clock keeps it deterministic:
// `sleep` advances a fake `now`, so nothing here waits in real time.
import { describe, it, expect } from "vitest";
import { pollUntil, sweepCandidatesUntil } from "../../../e2e/shared/poll-until";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("pollUntil", () => {
  it("returns the first successful value without sleeping", async () => {
    const clock = fakeClock();
    const res = await pollUntil(async () => ({ ok: true as const, value: 42 }), {
      deadlineMs: 1000,
      intervalMs: 100,
      ...clock,
    });
    expect(res).toEqual({ ok: true, value: 42, attempts: 1 });
    expect(clock.now()).toBe(0);
  });

  it("retries until the attempt succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await pollUntil(
      async () =>
        ++calls < 3
          ? { ok: false as const, reason: `not yet ${calls}` }
          : { ok: true as const, value: "up" },
      { deadlineMs: 1000, intervalMs: 100, ...clock }
    );
    expect(res).toEqual({ ok: true, value: "up", attempts: 3 });
    expect(clock.now()).toBe(200);
  });

  it("gives up at the deadline and reports the last failure reason", async () => {
    const clock = fakeClock();
    let calls = 0;
    const res = await pollUntil(async () => ({ ok: false as const, reason: `fail #${++calls}` }), {
      deadlineMs: 450,
      intervalMs: 100,
      ...clock,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.attempts).toBe(5);
    expect(res.reason).toBe("fail #5");
    expect(clock.now()).toBe(400);
  });

  it("makes a final attempt when elapsed + interval equals the deadline", async () => {
    const clock = fakeClock();
    const res = await pollUntil(async () => ({ ok: false as const, reason: "x" }), {
      deadlineMs: 400,
      intervalMs: 100,
      ...clock,
    });
    expect(res.ok === false && res.attempts).toBe(5);
  });

  it("treats a throwing attempt as a failure carrying its message", async () => {
    const clock = fakeClock();
    const res = await pollUntil(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      { deadlineMs: 200, intervalMs: 100, ...clock }
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("ECONNREFUSED");
  });
});

describe("sweepCandidatesUntil", () => {
  it("returns the first candidate that answers, in candidate order", async () => {
    const clock = fakeClock();
    const res = await sweepCandidatesUntil(
      ["a", "b", "c"],
      async (c) => (c === "b" || c === "c" ? { ok: true } : { ok: false, reason: "no" }),
      { deadlineMs: 1000, intervalMs: 100, ...clock }
    );
    expect(res).toEqual({ ok: true, candidate: "b" });
  });

  it("keeps sweeping until a candidate becomes reachable (slow container start)", async () => {
    const clock = fakeClock();
    let sweeps = 0;
    const res = await sweepCandidatesUntil(
      ["a", "b"],
      async (c) => {
        if (c === "a") sweeps++;
        return sweeps >= 3 && c === "b"
          ? { ok: true }
          : { ok: false, reason: "exec: container not ready" };
      },
      { deadlineMs: 5000, intervalMs: 100, ...clock }
    );
    expect(res).toEqual({ ok: true, candidate: "b" });
  });

  it("on timeout lists every candidate with its last failure reason", async () => {
    const clock = fakeClock();
    const calls: Record<string, number> = { a: 0, b: 0 };
    const res = await sweepCandidatesUntil(
      ["a", "b"],
      async (c) => ({ ok: false, reason: `reason for ${c} #${++calls[c]}` }),
      { deadlineMs: 300, intervalMs: 100, ...clock }
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 300ms / 100ms → 4 sweeps; the report must carry the LAST one, not the first.
    expect(res.failures).toEqual({ a: "reason for a #4", b: "reason for b #4" });
  });
});
