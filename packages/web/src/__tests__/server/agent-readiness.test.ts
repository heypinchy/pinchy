// Tests for the runtime-readiness gate that waits for a freshly (re)created
// agent to appear in OpenClaw's RUNTIME agents.list before Pinchy dispatches a
// chat to it.
//
// Why this gate exists and why it is reliable: OC's `agents.list` RPC
// (openclaw-node >= 0.12.0) reads `getRuntimeConfig()` — the SAME runtime view
// the chat-dispatch handler checks before accepting a message. So polling it
// until the agent appears is an authoritative, deterministic readiness signal,
// unlike `config.get` which reads the config FILE and leads the applied runtime
// by seconds-to-minutes while a write propagates. See agent-readiness.ts.
//
// The helper is decoupled from openclaw-node via injected deps so these unit
// tests pin the polling/deadline/graceful-degradation logic with a fake clock
// and need no Gateway. The real agents.list() wire shape is verified by the
// Docker E2E dispatch probes.

import { describe, it, expect, vi } from "vitest";
import { waitForAgentInRuntime } from "@/server/agent-readiness";

/**
 * Fake clock: `delay(ms)` advances `now` by `ms` synchronously so the
 * poll-interval / deadline logic runs deterministically without real timers.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    delay: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe("waitForAgentInRuntime", () => {
  it("resolves true immediately when the agent is already in the runtime list", async () => {
    const clock = fakeClock();
    const listRuntimeAgentIds = vi.fn(async () => ["smithers", "agent-1"]);

    const ready = await waitForAgentInRuntime(
      "agent-1",
      {
        hasAgentsListRpc: () => true,
        listRuntimeAgentIds,
        delay: clock.delay,
        now: clock.now,
      },
      { deadlineMs: 30_000 }
    );

    expect(ready).toBe(true);
    expect(listRuntimeAgentIds).toHaveBeenCalledTimes(1);
    expect(clock.delay).not.toHaveBeenCalled(); // fast path: no sleeping
  });

  it("polls until the agent appears, swallowing its initial absence", async () => {
    const clock = fakeClock();
    let calls = 0;
    const listRuntimeAgentIds = vi.fn(async () => {
      calls++;
      // Absent for the first two polls, present on the third.
      return calls >= 3 ? ["smithers", "late-agent"] : ["smithers"];
    });
    const onWaitObserved = vi.fn();

    const ready = await waitForAgentInRuntime(
      "late-agent",
      {
        hasAgentsListRpc: () => true,
        listRuntimeAgentIds,
        delay: clock.delay,
        now: clock.now,
        onWaitObserved,
      },
      { deadlineMs: 30_000, intervalMs: 500 }
    );

    expect(ready).toBe(true);
    expect(listRuntimeAgentIds).toHaveBeenCalledTimes(3);
    expect(clock.delay).toHaveBeenCalledTimes(2);
    expect(clock.now()).toBe(1000); // two 500 ms sleeps
    expect(onWaitObserved).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "late-agent", ready: true, polls: 3 })
    );
  });

  it("resolves false when the agent never appears within the deadline", async () => {
    const clock = fakeClock();
    const listRuntimeAgentIds = vi.fn(async () => ["smithers"]);
    const onWaitObserved = vi.fn();

    const ready = await waitForAgentInRuntime(
      "never-shows",
      {
        hasAgentsListRpc: () => true,
        listRuntimeAgentIds,
        delay: clock.delay,
        now: clock.now,
        onWaitObserved,
      },
      { deadlineMs: 2_000, intervalMs: 500 }
    );

    expect(ready).toBe(false);
    expect(clock.now()).toBe(2_000); // stopped exactly at the deadline
    expect(onWaitObserved).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "never-shows", ready: false })
    );
  });

  it("resolves false immediately, without polling, when the Gateway lacks agents.list", async () => {
    const clock = fakeClock();
    const listRuntimeAgentIds = vi.fn(async () => ["smithers"]);

    const ready = await waitForAgentInRuntime(
      "agent-1",
      {
        hasAgentsListRpc: () => false,
        listRuntimeAgentIds,
        delay: clock.delay,
        now: clock.now,
      },
      { deadlineMs: 30_000 }
    );

    expect(ready).toBe(false);
    expect(listRuntimeAgentIds).not.toHaveBeenCalled();
    expect(clock.delay).not.toHaveBeenCalled();
  });

  it("tolerates transient agents.list errors and keeps polling until the agent appears", async () => {
    const clock = fakeClock();
    let calls = 0;
    const listRuntimeAgentIds = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return calls >= 2 ? ["smithers", "agent-x"] : ["smithers"];
    });

    const ready = await waitForAgentInRuntime(
      "agent-x",
      {
        hasAgentsListRpc: () => true,
        listRuntimeAgentIds,
        delay: clock.delay,
        now: clock.now,
      },
      { deadlineMs: 30_000, intervalMs: 500 }
    );

    expect(ready).toBe(true);
    expect(listRuntimeAgentIds).toHaveBeenCalledTimes(2);
  });

  it("never reports a fast-path hit through onWaitObserved (only actual waits)", async () => {
    const clock = fakeClock();
    const onWaitObserved = vi.fn();

    await waitForAgentInRuntime(
      "agent-1",
      {
        hasAgentsListRpc: () => true,
        listRuntimeAgentIds: async () => ["agent-1"],
        delay: clock.delay,
        now: clock.now,
        onWaitObserved,
      },
      { deadlineMs: 30_000 }
    );

    expect(onWaitObserved).not.toHaveBeenCalled();
  });
});
