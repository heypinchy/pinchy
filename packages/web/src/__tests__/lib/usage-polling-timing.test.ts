/**
 * Integration-flavored timing tests for the poll-driven usage pipeline.
 *
 * These tests use the REAL `recordUsage` (not a spy) against a stateful
 * in-memory DB mock, so they exercise:
 *   - the cumulative-delta logic (subtract previously recorded sums from
 *     the current OpenClaw snapshot)
 *   - the per-session serialization via `pendingBySession` that prevents
 *     concurrent recordUsage calls from double-counting
 *
 * They validate the design assumptions from the usage-dashboard-improvements
 * plan — specifically that tokens added AFTER a "done" event are still
 * captured on the next poll, and that a concurrent done-event + poll does
 * not produce duplicate records for the same session window.
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
            // pollAllSessions uses this to build its agent name map
            return Promise.resolve([{ id: "agent-1", name: "Smithers" }]);
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
}));

import { recordUsage, _resetPricingCacheForTest, _resetPendingSessionsForTest } from "@/lib/usage";
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
