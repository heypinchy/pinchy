/**
 * Integration-flavored timing tests for the poll-driven usage pipeline.
 *
 * These tests use the REAL `recordUsage` (not a spy) against a stateful
 * in-memory DB mock, so they exercise:
 *   - the per-session watermark delta logic (the last-seen OpenClaw
 *     cumulative counter, which follows OpenClaw back down after a
 *     compaction/reset so post-reset tokens are counted correctly)
 *   - the per-session serialization via `pendingBySession` that prevents
 *     concurrent recordUsage calls from double-counting
 *   - the pendingBySession cleanup tail that prevents map leaks
 *   - the sessionSnapshot handoff from poller → recordUsage that avoids
 *     duplicate sessions.list() round-trips per poll tick
 *
 * They validate the design assumptions from the usage-dashboard-improvements
 * plan — specifically that tokens added AFTER a "done" event are still
 * captured on the next poll, that a concurrent done-event + poll does
 * not produce duplicate records for the same session window, and that
 * OpenClaw counter resets do not silently drop post-reset tokens.
 *
 * LIMITATION — the DB mock serves reads from a shared JS object with no
 * transaction isolation, which is strictly weaker than real Postgres. The
 * concurrent-call scenarios pass here because our `pendingBySession`
 * serialization avoids the race entirely before it ever reaches the DB,
 * not because the mock simulates row-level locking. A real Postgres
 * integration test (behind INTEGRATION_TEST=1, see
 * ./integration/usage-tracking.integration.test.ts) is the layer that can
 * catch actual transaction-ordering bugs. Changes to the pendingBySession
 * logic or cross-row locking should be re-verified against the real DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();

// Stateful DB: tracks cumulative delta inserts so repeated recordUsage
// calls see the same monotonically growing total that the real DB would
// return from sum(inputTokens)/sum(outputTokens).
interface DbState {
  inputSum: number;
  outputSum: number;
  cacheReadSum: number;
  cacheWriteSum: number;
}
const dbState: DbState = {
  inputSum: 0,
  outputSum: 0,
  cacheReadSum: 0,
  cacheWriteSum: 0,
};

function resetDbState(): void {
  dbState.inputSum = 0;
  dbState.outputSum = 0;
  dbState.cacheReadSum = 0;
  dbState.cacheWriteSum = 0;
}

vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (vals: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        }) => {
          mockValues(vals);
          dbState.inputSum += vals.inputTokens ?? 0;
          dbState.outputSum += vals.outputTokens ?? 0;
          dbState.cacheReadSum += vals.cacheReadTokens ?? 0;
          dbState.cacheWriteSum += vals.cacheWriteTokens ?? 0;
          return Promise.resolve();
        },
      };
    },
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (table: { _table?: string }) => {
          mockFrom(table);
          if (table?._table === "agents") {
            // pollAllSessions uses this to build its agent name map.
            // Since the poller was hardened to filter soft-deleted agents
            // via `.where(isNull(agents.deletedAt))`, the mock must also
            // expose a chainable `.where()` on this branch.
            return {
              where: (..._wArgs: unknown[]) => {
                mockWhere(..._wArgs);
                return Promise.resolve([{ id: "agent-1", name: "Smithers" }]);
              },
            };
          }
          // usageRecords — chainable with where() to read the running sum
          return {
            where: (...wArgs: unknown[]) => {
              mockWhere(...wArgs);
              return Promise.resolve([
                {
                  totalInput: String(dbState.inputSum),
                  totalOutput: String(dbState.outputSum),
                  totalCacheRead: String(dbState.cacheReadSum),
                  totalCacheWrite: String(dbState.cacheWriteSum),
                },
              ]);
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: { _table: "usage_records" },
  agents: { _table: "agents", id: "id", name: "name" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col, val) => ({ _type: "eq", val })),
  sum: vi.fn((col) => ({ _type: "sum", col })),
  isNull: vi.fn((col) => ({ _type: "isNull", col })),
}));

import {
  recordUsage,
  _resetPricingCacheForTest,
  _resetPendingSessionsForTest,
  _resetUsageWatermarksForTest,
  _getPendingSessionsCountForTest,
} from "@/lib/usage";
import { pollAllSessions } from "@/lib/usage-poller";

interface MutableSession {
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
}

function makeClient(sessionRef: { current: MutableSession }) {
  return {
    sessions: {
      list: vi.fn().mockImplementation(() =>
        Promise.resolve({
          sessions: [sessionRef.current],
        })
      ),
    },
    config: {
      get: vi.fn().mockResolvedValue({ config: { models: { providers: {} } } }),
    },
  } as unknown as Parameters<typeof pollAllSessions>[0];
}

const SESSION_KEY = "agent:agent-1:direct:user-1";
const baseParams = {
  userId: "user-1",
  agentId: "agent-1",
  agentName: "Smithers",
  sessionKey: SESSION_KEY,
};

describe("polling timing scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
    _resetPricingCacheForTest();
    _resetPendingSessionsForTest();
    _resetUsageWatermarksForTest();
  });

  it("captures tokens added after 'done' event on next poll cycle", async () => {
    // Scenario from the design doc: OpenClaw fires "done" when assistant
    // text streaming finishes, but background tool calls (e.g. vision API,
    // subagent spawn) can add tokens afterwards. Those tokens would be
    // lost without the poller — this test proves the poller captures them.

    const sessionRef = {
      current: {
        key: SESSION_KEY,
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      } as MutableSession,
    };
    const client = makeClient(sessionRef);

    // Step 1: "done" event fires, recordUsage inserts the initial snapshot.
    await recordUsage({ openclawClient: client, ...baseParams });
    expect(mockValues).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ inputTokens: 100, outputTokens: 50 })
    );
    expect(dbState.inputSum).toBe(100);
    expect(dbState.outputSum).toBe(50);

    // Step 2: Background work bumps session tokens in OpenClaw — no event
    // fires, nothing gets recorded yet.
    sessionRef.current = {
      ...sessionRef.current,
      inputTokens: 250,
      outputTokens: 80,
    };

    // Step 3: Poller runs. It sees the grown session and inserts the delta.
    await pollAllSessions(client);

    expect(mockValues).toHaveBeenCalledTimes(2);
    expect(mockValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ inputTokens: 150, outputTokens: 30 })
    );
    // Running totals in DB now reflect the full OpenClaw snapshot
    expect(dbState.inputSum).toBe(250);
    expect(dbState.outputSum).toBe(80);
  });

  it("accumulates deltas correctly across multiple poll cycles", async () => {
    // Simulate a long-running chat: tokens grow monotonically over 3 polls.
    // The sum of all recorded deltas must equal the final OpenClaw total.

    const sessionRef = {
      current: {
        key: SESSION_KEY,
        inputTokens: 100,
        outputTokens: 0,
        model: "test-model",
      } as MutableSession,
    };
    const client = makeClient(sessionRef);

    // Tick 1: 100 input tokens → delta 100
    await pollAllSessions(client);
    expect(mockValues).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputTokens: 100, outputTokens: 0 })
    );

    // Tick 2: 200 input tokens (delta 100)
    sessionRef.current = { ...sessionRef.current, inputTokens: 200 };
    await pollAllSessions(client);
    expect(mockValues).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputTokens: 100, outputTokens: 0 })
    );

    // Tick 3: 350 input tokens (delta 150)
    sessionRef.current = { ...sessionRef.current, inputTokens: 350 };
    await pollAllSessions(client);
    expect(mockValues).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputTokens: 150, outputTokens: 0 })
    );

    // Final DB total must match OpenClaw's cumulative counter.
    expect(dbState.inputSum).toBe(350);
    expect(mockValues).toHaveBeenCalledTimes(3);
  });

  it("never writes a negative delta on any token axis", async () => {
    // Scenario: OpenClaw's cumulative counter drops on one or more axes —
    // e.g. after context pruning, compaction, or a session restart. Without
    // correct clamping, recordUsage would insert NEGATIVE values into
    // usage_records, which corrupts sum(inputTokens) / sum(outputTokens) /
    // sum(cacheReadTokens) / sum(cacheWriteTokens) aggregates on the dashboard.
    //
    // The original guard `deltaInput <= 0 && deltaOutput <= 0` only caught the
    // full-reset case. It did not catch:
    //   (a) mixed axis: input grows but output drops (or vice versa)
    //   (b) cache axes: input/output grow positively, but cacheRead/cacheWrite
    //       drop — no guard was checking them at all.

    const sessionRef = {
      current: {
        key: SESSION_KEY,
        inputTokens: 300,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        model: "test-model",
      } as MutableSession,
    };
    const client = makeClient(sessionRef);

    // Baseline insert.
    await recordUsage({ openclawClient: client, ...baseParams });
    expect(mockValues).toHaveBeenCalledTimes(1);
    expect(dbState.inputSum).toBe(300);
    expect(dbState.outputSum).toBe(200);
    expect(dbState.cacheReadSum).toBe(100);
    expect(dbState.cacheWriteSum).toBe(50);

    // Case (a): input grows, output drops. Old guard: deltaInput=50 is NOT <=0,
    // so the skip short-circuits and the insert goes through with deltaOutput=-20.
    sessionRef.current = {
      ...sessionRef.current,
      inputTokens: 350, // +50
      outputTokens: 180, // -20
      cacheReadTokens: 100, // 0
      cacheWriteTokens: 50, // 0
    };
    await recordUsage({ openclawClient: client, ...baseParams });
    // dbState must never go backwards.
    expect(dbState.outputSum).toBeGreaterThanOrEqual(200);
    // And no inserted row may have a negative value on any axis.
    for (const call of mockValues.mock.calls) {
      const vals = call[0] as {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
      expect(vals.inputTokens).toBeGreaterThanOrEqual(0);
      expect(vals.outputTokens).toBeGreaterThanOrEqual(0);
      expect(vals.cacheReadTokens).toBeGreaterThanOrEqual(0);
      expect(vals.cacheWriteTokens).toBeGreaterThanOrEqual(0);
    }

    // Case (b): input AND output grow (guard does not skip), but cache axes
    // drop. The insert must not contain negative cache deltas.
    const insertsBefore = mockValues.mock.calls.length;
    sessionRef.current = {
      ...sessionRef.current,
      inputTokens: 400, // +50 over prev dbState of 350 (or the guard reads sum=350)
      outputTokens: 220, // +20 over prev dbState
      cacheReadTokens: 60, // -40 vs dbState.cacheReadSum (was 100, never went up)
      cacheWriteTokens: 30, // -20 vs dbState.cacheWriteSum
    };
    await recordUsage({ openclawClient: client, ...baseParams });

    // A new insert should have happened (input/output both grew positively).
    expect(mockValues.mock.calls.length).toBeGreaterThan(insertsBefore);
    const lastCall = mockValues.mock.calls[mockValues.mock.calls.length - 1][0] as {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    expect(lastCall.inputTokens).toBeGreaterThanOrEqual(0);
    expect(lastCall.outputTokens).toBeGreaterThanOrEqual(0);
    expect(lastCall.cacheReadTokens).toBeGreaterThanOrEqual(0);
    expect(lastCall.cacheWriteTokens).toBeGreaterThanOrEqual(0);
  });

  it("cleans up pending-session entries after recordUsage resolves", async () => {
    // Without cleanup, pendingBySession grows unbounded — every unique
    // session key ever seen by Pinchy stays in the map for the lifetime
    // of the process. On a long-running deployment with many short chats
    // this is a slow memory leak. The fix is a .finally() at the tail of
    // the chain that deletes the map entry once it's safe (i.e. no later
    // call has replaced it).
    const sessionRef = {
      current: {
        key: SESSION_KEY,
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      } as MutableSession,
    };
    const client = makeClient(sessionRef);

    expect(_getPendingSessionsCountForTest()).toBe(0);
    await recordUsage({ openclawClient: client, ...baseParams });
    expect(_getPendingSessionsCountForTest()).toBe(0);
  });

  it("poller avoids duplicate sessions.list calls on recordUsage", async () => {
    // The poller already fetches sessions.list() to discover which sessions
    // have tokens to record. recordUsage should consume the snapshot passed
    // by the poller instead of making a second round-trip — otherwise every
    // poll tick doubles the OpenClaw sessions.list traffic (and per-session
    // that cost scales linearly with the number of active chat sessions).
    const sessionRef = {
      current: {
        key: SESSION_KEY,
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      } as MutableSession,
    };
    const client = makeClient(sessionRef);
    const listSpy = (client as unknown as { sessions: { list: ReturnType<typeof vi.fn> } }).sessions
      .list;

    await pollAllSessions(client);

    expect(mockValues).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("recovers from OpenClaw counter reset (compaction)", async () => {
    // Per upstream research (OpenClaw src/gateway/server-methods/sessions.ts
    // ~line 1569, session-reset-service.ts ~line 639, and the auto-reply
    // compaction path), a session's inputTokens/outputTokens/cacheRead/
    // cacheWrite fields are NOT monotonic — they get cleared on compaction,
    // session-reset, or checkpoint clone, then re-accumulate from zero.
    //
    // The old DB-sum baseline ALWAYS sees `current < historical sum` after
    // a reset, so every per-axis delta clamps to 0 and we silently drop
    // every post-reset token forever. The fix is a per-session watermark
    // tracking the last observed OpenClaw counter (which moves backwards
    // on reset), independent of the DB aggregate.
    const sessionRef = {
      current: {
        key: SESSION_KEY,
        inputTokens: 500,
        outputTokens: 200,
        model: "test-model",
      } as MutableSession,
    };
    const client = makeClient(sessionRef);

    // Pre-reset: 500/200 tokens get recorded normally.
    await recordUsage({ openclawClient: client, ...baseParams });
    expect(dbState.inputSum).toBe(500);
    expect(dbState.outputSum).toBe(200);

    // OpenClaw compacts the session — cumulative counters drop to 0.
    // No delta should be recorded (compaction reshuffles internal state,
    // it doesn't undo already-billed tokens), but the watermark must
    // follow OpenClaw back down to 0 so the next growth is recognized.
    sessionRef.current = { ...sessionRef.current, inputTokens: 0, outputTokens: 0 };
    await recordUsage({ openclawClient: client, ...baseParams });
    expect(dbState.inputSum).toBe(500);
    expect(dbState.outputSum).toBe(200);

    // New tokens accumulate after the reset: 300 input, 100 output.
    sessionRef.current = { ...sessionRef.current, inputTokens: 300, outputTokens: 100 };
    await recordUsage({ openclawClient: client, ...baseParams });

    // These post-reset tokens MUST be counted. The old implementation
    // would have computed max(0, 300-500)=0 and silently dropped them.
    expect(dbState.inputSum).toBe(800);
    expect(dbState.outputSum).toBe(300);
  });

  it("handles concurrent done-event and poll without double-counting", async () => {
    // Two recordUsage calls are issued back-to-back for the same session
    // (simulates a "done" event firing just as pollAllSessions wakes up).
    // Without pendingBySession serialization, both would read sum=0 from
    // the DB and each insert a full 100-token delta — doubling the real
    // usage. The serialization chain must force the second call to see
    // the first call's insert and skip its redundant delta.

    const sessionRef = {
      current: {
        key: SESSION_KEY,
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      } as MutableSession,
    };
    const client = makeClient(sessionRef);

    // Kick off both calls without awaiting either — they race on the queue.
    const call1 = recordUsage({ openclawClient: client, ...baseParams });
    const call2 = recordUsage({ openclawClient: client, ...baseParams });

    await Promise.all([call1, call2]);

    // Exactly one insert: first call wrote delta 100/50, second call saw
    // the resulting sum and computed delta 0/0 (skipped).
    expect(mockValues).toHaveBeenCalledTimes(1);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100, outputTokens: 50 })
    );
    expect(dbState.inputSum).toBe(100);
    expect(dbState.outputSum).toBe(50);
  });
});
