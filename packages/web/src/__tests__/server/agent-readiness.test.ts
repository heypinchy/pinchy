// Tests for the runtime-readiness gate that waits for a freshly (re)created
// agent to appear in OpenClaw's RUNTIME agents.list before Pinchy dispatches a
// chat to it.
//
// Why this gate exists and why it is reliable: OC's `agents.list` RPC
// (openclaw-node >= 0.12.0) reads `getRuntimeConfig()` — the SAME runtime view
// the chat-dispatch handler checks before accepting a message. Filtered through
// `dispatchableAgentIds` (it also lists agent directories from disk while the
// runtime list is empty), polling it is a deterministic readiness signal,
// unlike `config.get` which reads the config FILE and leads the applied runtime
// by seconds-to-minutes while a write propagates. See agent-readiness.ts.
//
// The helper is decoupled from openclaw-node via injected deps so these unit
// tests pin the polling/deadline/graceful-degradation logic with a fake clock
// and need no Gateway. The real agents.list() wire shape is verified by the
// Docker E2E dispatch probes.

import { describe, it, expect, vi } from "vitest";
import type { AgentsListResult, OpenClawClient } from "openclaw-node";
import {
  dispatchableAgentIds,
  waitForAgentInRuntime,
  waitForAgentInRuntimeOnClient,
} from "@/server/agent-readiness";

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

// OpenClaw 2026.7.1's `agents.list` handler (`listAgentsForGateway`) and the
// `agent` dispatch handler (`listAgentIds`) both read `getRuntimeConfig()`, but
// they derive different id sets from it. While the runtime `agents.list` is
// EMPTY (e.g. right after a gateway restart, before Pinchy's agents apply),
// `agents.list` falls back to every directory under `<stateDir>/agents/` —
// Pinchy's agents included — whereas dispatch accepts only the default `main`,
// which Pinchy never dispatches to. A configured entry is recognised by a
// non-`main` defaultId, or by its `name`/`identity` (Pinchy always writes a
// name); a disk-only entry has neither. CI run 41569393728.
describe("dispatchableAgentIds", () => {
  it("keeps entries that come from the configured runtime agents.list", () => {
    expect(
      dispatchableAgentIds({
        defaultId: "agent-1",
        agents: [
          { id: "agent-1", name: "Smithers" },
          { id: "agent-2", identity: { name: "Ops" } },
        ],
      })
    ).toEqual(["agent-1", "agent-2"]);
  });

  it("keeps every entry when the configured list is non-empty, even without names", () => {
    // A non-empty configured list makes OC's default a configured agent (never
    // `main`) and filters `agents.list` down to configured ids, so every entry
    // is dispatchable. This keeps the gate working if a future OC stops
    // echoing the configured `name`.
    expect(
      dispatchableAgentIds({
        defaultId: "agent-1",
        agents: [{ id: "agent-1" }, { id: "agent-2" }],
      })
    ).toEqual(["agent-1", "agent-2"]);
  });

  it("falls back to the name/identity signal when the result carries no defaultId", () => {
    expect(
      dispatchableAgentIds({
        agents: [
          { id: "agent-1", name: "Smithers" },
          { id: "agent-2" },
          { id: "agent-3", identity: { emoji: "🦞" } },
          { id: "agent-4", identity: null },
        ],
      } as unknown as AgentsListResult)
    ).toEqual(["agent-1", "agent-3"]);
  });

  it("drops disk-discovered entries and the `main` fallback while the configured list is empty", () => {
    // Runtime agents.list empty: OC lists `main` plus the agent directories.
    expect(
      dispatchableAgentIds({
        defaultId: "main",
        mainKey: "main",
        agents: [{ id: "main" }, { id: "5747120b-4fee-4c87-8f62-45f663e58a80" }],
      })
    ).toEqual([]);
  });
});

describe("waitForAgentInRuntimeOnClient", () => {
  function clientWith(opts: {
    hasMethod?: boolean;
    list: () => Promise<AgentsListResult>;
  }): OpenClawClient & { config: { get: ReturnType<typeof vi.fn> } } {
    return {
      hasMethod: vi.fn(() => opts.hasMethod ?? true),
      agents: { list: vi.fn(opts.list) },
      // OC 2026.9: the file snapshot carries `agents.entries`; the `list`
      // projection is non-enumerable and never reaches the wire.
      config: {
        get: vi.fn(async () => ({ config: { agents: { entries: { "new-agent": {} } } } })),
      },
    } as unknown as OpenClawClient & { config: { get: ReturnType<typeof vi.fn> } };
  }

  const roster = (ids: string[]): AgentsListResult =>
    ({
      defaultId: ids[0] ?? "main",
      mainKey: "main",
      scope: "per-sender",
      agents: ids.map((id) => ({ id, name: id })),
    }) as unknown as AgentsListResult;

  it("confirms an agent that the agents.list RPC reports, ignoring config.get", async () => {
    const client = clientWith({ list: async () => roster(["new-agent"]) });

    expect(await waitForAgentInRuntimeOnClient(client, "new-agent")).toBe(true);
    expect(client.config.get).not.toHaveBeenCalled();
  });

  it("keeps polling through a transient agents.list error until the agent appears", async () => {
    let calls = 0;
    const client = clientWith({
      list: async () => {
        calls++;
        if (calls <= 2) throw new Error("WebSocket disconnected");
        return roster(["new-agent"]);
      },
    });

    expect(await waitForAgentInRuntimeOnClient(client, "new-agent")).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("returns false at once when there is no client (OpenClaw not connected)", async () => {
    expect(await waitForAgentInRuntimeOnClient(null, "any")).toBe(false);
  });

  it("returns false at once on a Gateway without the agents.list RPC", async () => {
    const client = clientWith({ hasMethod: false, list: async () => roster(["new-agent"]) });

    expect(await waitForAgentInRuntimeOnClient(client, "new-agent")).toBe(false);
    expect(client.agents.list).not.toHaveBeenCalled();
  });
});
