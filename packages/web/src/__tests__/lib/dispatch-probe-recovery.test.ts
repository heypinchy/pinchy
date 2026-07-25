// Unit tests for the E2E dispatch-probe recovery orchestrator
// `ensureAgentDispatchable` (e2e/shared/dispatch-probe.ts).
//
// OpenClaw hard-caps control-plane writes (`config.apply`) at 3 per 60s per
// connection — a compiled-in constant with NO env/config override. Under the
// integration suite's cumulative config-mutation rate, `pushConfigInBackground`
// parks a rejected apply for ~2×50s and then falls back to a file write whose
// inotify reload can lag past a fixed dispatchability deadline. That is the
// kb-attribution / pinchy-knowledge `beforeAll` flake: `waitForOpenClawStable`
// reports settled (the file-write fallback drained `configPushesPending`) while
// the agent is not yet in OC's runtime, and `waitForAgentDispatchable` then
// times out.
//
// `ensureAgentDispatchable` recovers because it runs inside a BLOCKING
// `beforeAll` — no other `config.apply` competes, so the rate-limit window
// drains within ~60s. Toggling the tool grant off→on forces a genuine config
// diff, and the resulting clean WS `config.apply` refreshes OC's runtime
// in-process, bypassing the lagging file-watcher entirely.
//
// These tests are wall-clock/interaction based, not poll-count based, mirroring
// dispatch-probe-stability.test.ts (under CI load `setTimeout` stretches).

import { describe, it, expect, vi } from "vitest";
import { ensureAgentDispatchable } from "../../../e2e/shared/dispatch-probe";

const TOOLS = ["knowledge_search"];

/** Always-settled health so the stability gate never gates these tests. */
const settledHealth = async () => ({
  ok: true,
  json: async () => ({ connected: true, configPushesPending: 0 }),
});

const fastOpts = {
  stableOpts: { deadlineMs: 1_000, stableForMs: 10, intervalMs: 5 },
  dispatchDeadlineMs: 40,
  dispatchIntervalMs: 5,
  maxRecoveryAttempts: 2,
  overallDeadlineMs: 10_000,
} as const;

/** `fastOpts` without `maxRecoveryAttempts`, to exercise its `?? 2` default. */
const fastOptsDefaultAttempts = {
  stableOpts: fastOpts.stableOpts,
  dispatchDeadlineMs: fastOpts.dispatchDeadlineMs,
  dispatchIntervalMs: fastOpts.dispatchIntervalMs,
  overallDeadlineMs: fastOpts.overallDeadlineMs,
} as const;

describe("ensureAgentDispatchable", () => {
  it("returns without recovery when the agent is already dispatchable", async () => {
    const setAllowedTools = vi.fn(async () => {});

    await ensureAgentDispatchable({
      agentId: "a1",
      allowedTools: TOOLS,
      fetchHealth: settledHealth,
      fetchDispatch: async () => ({ ok: true, json: async () => ({ agentDispatchable: true }) }),
      setAllowedTools,
      opts: fastOpts,
    });

    // The happy path never touches the tool grant.
    expect(setAllowedTools).not.toHaveBeenCalled();
  });

  it("recovers by toggling the tool grant off→on when the first dispatch wait times out", async () => {
    // Model the real system: the agent only enters OC's runtime once the grant
    // is RESTORED (the clean WS config.apply). Until then dispatch stays false.
    let restored = false;
    const setAllowedTools = vi.fn(async (tools: string[]) => {
      if (tools.length > 0) restored = true;
    });

    await ensureAgentDispatchable({
      agentId: "a1",
      allowedTools: TOOLS,
      fetchHealth: settledHealth,
      fetchDispatch: async () => ({
        ok: true,
        json: async () => ({ agentDispatchable: restored }),
      }),
      setAllowedTools,
      opts: fastOpts,
    });

    // Exactly one toggle: clear the grant, then restore it.
    expect(setAllowedTools.mock.calls.map((c) => c[0])).toEqual([[], TOOLS]);
  });

  it("throws after exhausting recovery attempts when the agent never becomes dispatchable", async () => {
    const setAllowedTools = vi.fn(async () => {});

    await expect(
      ensureAgentDispatchable({
        agentId: "a1",
        allowedTools: TOOLS,
        fetchHealth: settledHealth,
        fetchDispatch: async () => ({
          ok: true,
          json: async () => ({ agentDispatchable: false }),
        }),
        setAllowedTools,
        opts: fastOpts,
      })
      // The helper's OWN attempt-counted message, not a bare relay of the inner
      // wait's error — this is what a beforeAll timeout must not be allowed to
      // mask (Fix: informative give-up).
    ).rejects.toThrow(/dispatchable after 2 recovery attempt/i);

    // maxRecoveryAttempts (2) toggles, each = clear + restore = 2 calls.
    expect(setAllowedTools).toHaveBeenCalledTimes(4);
  });

  it("defaults to 2 recovery attempts when maxRecoveryAttempts is omitted", async () => {
    const setAllowedTools = vi.fn(async () => {});

    await expect(
      ensureAgentDispatchable({
        agentId: "a1",
        allowedTools: TOOLS,
        fetchHealth: settledHealth,
        fetchDispatch: async () => ({
          ok: true,
          json: async () => ({ agentDispatchable: false }),
        }),
        setAllowedTools,
        opts: fastOptsDefaultAttempts,
      })
    ).rejects.toThrow(/dispatchable after 2 recovery attempt/i);

    // The `?? 2` default still yields exactly two toggles (4 calls).
    expect(setAllowedTools).toHaveBeenCalledTimes(4);
  });

  it("honours the overall wall-clock budget even when maxRecoveryAttempts is high", async () => {
    // With a huge attempt cap, only the overall budget can stop the loop — this
    // pins the bound that keeps the helper self-throwing before a beforeAll
    // Playwright timeout (Fix: overall budget clamps every internal wait).
    const setAllowedTools = vi.fn(async () => {});

    await expect(
      ensureAgentDispatchable({
        agentId: "a1",
        allowedTools: TOOLS,
        fetchHealth: settledHealth,
        fetchDispatch: async () => ({
          ok: true,
          json: async () => ({ agentDispatchable: false }),
        }),
        setAllowedTools,
        opts: {
          stableOpts: { deadlineMs: 200, stableForMs: 10, intervalMs: 5 },
          dispatchDeadlineMs: 20,
          dispatchIntervalMs: 5,
          maxRecoveryAttempts: 1_000,
          overallDeadlineMs: 60,
        },
      })
    ).rejects.toThrow(/dispatchable/i);

    // It gave up on the budget, not the (never-reached) 1000-attempt cap.
    expect(setAllowedTools.mock.calls.length).toBeLessThan(2_000);
  });
});
