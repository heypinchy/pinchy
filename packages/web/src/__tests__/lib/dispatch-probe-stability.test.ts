// Unit tests for the E2E dispatch-probe stability gate (e2e/shared/dispatch-probe.ts).
//
// The gate must wait not only for `connected=true` but also for
// `configPushesPending === 0`: a rate-limited `config.apply` parks a push
// coroutine for 33–53 s during which OC stays connected — so a connection-only
// stability window passes while a freshly-granted per-agent plugin config is
// still NOT in OC's runtime, and the suite dispatches a chat whose run lacks
// the granted tools (the email dispatch-probe flake).

import { describe, it, expect } from "vitest";
import { waitForOpenClawStable } from "../../../e2e/shared/dispatch-probe";

type HealthBody = { connected?: boolean; configPushesPending?: number };

function healthSequence(bodies: HealthBody[]) {
  let calls = 0;
  let firstSettledAt: number | null = null;
  const fetchHealth = async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)];
    calls++;
    if ((body.configPushesPending ?? 0) === 0 && body.connected) {
      firstSettledAt ??= Date.now();
    }
    return { ok: true, json: async () => body };
  };
  return { fetchHealth, callCount: () => calls, firstSettledAt: () => firstSettledAt };
}

describe("waitForOpenClawStable", () => {
  it("does not report stable while configPushesPending > 0, then settles once pushes drain", async () => {
    // First 5 polls: connected but a push is parked (rate-limit window).
    // Afterwards: pending drains to 0 → the stable window may start.
    //
    // Assertions are deliberately wall-clock-based, NOT poll-count-based: under
    // CI load `setTimeout(intervalMs)` stretches, so the number of polls needed
    // to span the stable window is unpredictable (a poll-count assertion here
    // was itself flaky). The contract is: (a) every pending response is
    // consumed before returning, and (b) the stable window only starts at the
    // first settled response.
    const pending: HealthBody = { connected: true, configPushesPending: 1 };
    const settled: HealthBody = { connected: true, configPushesPending: 0 };
    const { fetchHealth, callCount, firstSettledAt } = healthSequence([
      pending,
      pending,
      pending,
      pending,
      pending,
      settled,
    ]);

    await waitForOpenClawStable(fetchHealth, {
      deadlineMs: 5_000,
      stableForMs: 30,
      intervalMs: 5,
    });
    const resolvedAt = Date.now();

    // (a) It cannot have returned during the pending phase: all five pending
    // responses (plus at least one settled) were consumed.
    expect(callCount()).toBeGreaterThanOrEqual(6);
    // (b) The stableFor window was measured from the FIRST settled poll — the
    // pending polls did not count toward it.
    expect(firstSettledAt()).not.toBeNull();
    expect(resolvedAt - (firstSettledAt() as number)).toBeGreaterThanOrEqual(30);
  });

  it("treats a missing configPushesPending field as settled (backwards compatible)", async () => {
    const { fetchHealth } = healthSequence([{ connected: true }]);
    await expect(
      waitForOpenClawStable(fetchHealth, { deadlineMs: 2_000, stableForMs: 20, intervalMs: 5 })
    ).resolves.toBeUndefined();
  });

  it("throws at the deadline when pushes never settle (bounded, loud failure)", async () => {
    const { fetchHealth } = healthSequence([{ connected: true, configPushesPending: 1 }]);
    await expect(
      waitForOpenClawStable(fetchHealth, { deadlineMs: 100, stableForMs: 20, intervalMs: 5 })
    ).rejects.toThrow(/did not stabilise/);
  });
});
