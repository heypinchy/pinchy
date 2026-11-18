import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import {
  aggregateTokenUsage,
  collectRunTokens,
  makeTokenCollector,
  type UsageRow,
} from "../token-usage";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  contextTokens: null,
  estimatedCostUsd: null,
  ...over,
});

describe("aggregateTokenUsage", () => {
  it("returns undefined for no rows (no usage recorded for this run)", () => {
    expect(aggregateTokenUsage([])).toBeUndefined();
  });

  it("sums input/output across every turn of the run's tool loop", () => {
    const usage = aggregateTokenUsage([
      row({ inputTokens: 100, outputTokens: 20 }),
      row({ inputTokens: 250, outputTokens: 40 }),
      row({ inputTokens: 30, outputTokens: 5 }),
    ]);
    expect(usage).toMatchObject({ prompt: 380, completion: 65 });
  });

  it("counts cacheRead/cacheWrite as prompt tokens (all three prompt classes the model read)", () => {
    // input/cacheRead/cacheWrite are disjoint (see usage-from-trajectory.ts);
    // all three are tokens the model read, differing only in billing. Dropping
    // the cache classes under-reports prompt volume on caching hosters.
    const usage = aggregateTokenUsage([
      row({ inputTokens: 5, cacheReadTokens: 630, cacheWriteTokens: 320, outputTokens: 12 }),
    ]);
    expect(usage).toMatchObject({ prompt: 955, completion: 12 });
  });

  it("takes the PEAK context (max), not the sum — context is window pressure", () => {
    const usage = aggregateTokenUsage([
      row({ contextTokens: 12_000 }),
      row({ contextTokens: 47_000 }),
      row({ contextTokens: 31_000 }),
    ]);
    expect(usage?.contextTokens).toBe(47_000);
  });

  it("ignores null context turns when taking the peak", () => {
    const usage = aggregateTokenUsage([
      row({ contextTokens: null }),
      row({ contextTokens: 8_000 }),
      row({ contextTokens: null }),
    ]);
    expect(usage?.contextTokens).toBe(8_000);
  });

  it("omits contextTokens entirely when every turn recorded it as null", () => {
    const usage = aggregateTokenUsage([row({ inputTokens: 10 }), row({ inputTokens: 10 })]);
    expect(usage).toBeDefined();
    expect(usage).not.toHaveProperty("contextTokens");
  });

  it("sums estimated cost, parsing the postgres numeric string", () => {
    const usage = aggregateTokenUsage([
      row({ estimatedCostUsd: "0.001200" }),
      row({ estimatedCostUsd: "0.000800" }),
    ]);
    expect(usage?.costUsd).toBeCloseTo(0.002, 6);
  });

  it("omits costUsd when no turn priced per token (Ollama Cloud subscription)", () => {
    const usage = aggregateTokenUsage([
      row({ inputTokens: 10, estimatedCostUsd: null }),
      row({ inputTokens: 10, estimatedCostUsd: null }),
    ]);
    expect(usage).toBeDefined();
    expect(usage).not.toHaveProperty("costUsd");
  });
});

// A scripted clock + query so the polling loop is deterministic without a DB.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

/** A query whose successive calls return the next scripted row-set. */
function scriptedQuery(script: UsageRow[][]): () => Promise<UsageRow[]> {
  let i = 0;
  return () => Promise.resolve(script[Math.min(i++, script.length - 1)]);
}

describe("collectRunTokens", () => {
  const clockOpts = () => {
    const clock = fakeClock();
    return { timeoutMs: 20_000, intervalMs: 500, now: clock.now, sleep: clock.sleep };
  };

  it("returns the aggregate once the row count is stable across two reads", async () => {
    const usage = await collectRunTokens(
      scriptedQuery([
        [row({ inputTokens: 42, outputTokens: 17 })],
        [row({ inputTokens: 42, outputTokens: 17 })],
      ]),
      clockOpts()
    );
    expect(usage).toMatchObject({ prompt: 42, completion: 17 });
  });

  it("keeps polling while the recorder is still writing turns, then settles", async () => {
    // 1 row, then 3 (recorder catching up), then 3 stable → sum of the 3.
    const three = [
      row({ inputTokens: 100, outputTokens: 10 }),
      row({ inputTokens: 100, outputTokens: 10 }),
      row({ inputTokens: 100, outputTokens: 10 }),
    ];
    const usage = await collectRunTokens(
      scriptedQuery([[row({ inputTokens: 100, outputTokens: 10 })], three, three]),
      clockOpts()
    );
    expect(usage).toMatchObject({ prompt: 300, completion: 30 });
  });

  it("returns undefined when no usage row ever appears before the timeout", async () => {
    const usage = await collectRunTokens(scriptedQuery([[]]), clockOpts());
    expect(usage).toBeUndefined();
  });

  it("returns the best-effort aggregate if rows appear but never stabilize", async () => {
    // Count grows every single poll and never plateaus → on timeout, return the
    // last aggregate seen rather than throwing away a partial count.
    let n = 0;
    const everGrowing = () => {
      n += 1;
      return Promise.resolve(Array.from({ length: n }, () => row({ inputTokens: 10 })));
    };
    const usage = await collectRunTokens(everGrowing, clockOpts());
    expect(usage).toBeDefined();
    expect(usage!.prompt).toBeGreaterThan(0);
  });

  it("never throws — a query error degrades to undefined, never aborts the sweep", async () => {
    const usage = await collectRunTokens(() => Promise.reject(new Error("db down")), clockOpts());
    expect(usage).toBeUndefined();
  });

  it("reports the query error via onQueryError so a systemic break is not fully silent", async () => {
    const errors: unknown[] = [];
    const usage = await collectRunTokens(() => Promise.reject(new Error("db down")), {
      ...clockOpts(),
      onQueryError: (e) => errors.push(e),
    });
    expect(usage).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("db down");
  });
});

// A fake `Sql` tagged-template. `makeTokenCollector` interpolates `${agentId}`
// then `${pattern}`, so the LIKE pattern is always the last interpolated value.
function fakeSql(onCall: (pattern: string) => Promise<UsageRow[]>): Sql {
  const tag = (_strings: TemplateStringsArray, ...values: unknown[]) =>
    onCall(values[values.length - 1] as string);
  return tag as unknown as Sql;
}

describe("makeTokenCollector", () => {
  const clockOpts = () => {
    const clock = fakeClock();
    return { timeoutMs: 20_000, intervalMs: 500, now: clock.now, sleep: clock.sleep };
  };

  it("lowercases the session_key pattern to match the stored (lowercased) key", async () => {
    // usage_records.session_key is written lowercased (see lib/usage*.ts), so a
    // raw mixed-case agentId/chatId would silently never match. Verify the
    // pattern is folded to lower case.
    let seen: string | undefined;
    const collect = makeTokenCollector(
      fakeSql((pattern) => {
        seen = pattern;
        return Promise.resolve([]);
      }),
      clockOpts()
    );
    await collect("Agent-ABC", "Chat-DEF");
    expect(seen).toBe("agent:agent-abc:direct:%:chat-def");
  });

  it("warns at most once per sweep even if every run's join query keeps failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collect = makeTokenCollector(
        fakeSql(() => Promise.reject(new Error("boom"))),
        clockOpts()
      );
      expect(await collect("a", "chat-1")).toBeUndefined();
      expect(await collect("a", "chat-2")).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
