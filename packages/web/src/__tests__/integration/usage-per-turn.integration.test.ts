/**
 * Tier-2 per-turn usage accounting (#483) against a REAL PostgreSQL.
 *
 * Proves the two things a faked DB cannot: (1) the unique index
 * uq_usage_session_run(session_key, run_id) actually makes a repeated
 * (sessionKey, runId) insert a no-op under real PG (gauge/internal rows keep
 * run_id NULL, exempt via Postgres NULLS DISTINCT), so
 * re-scans / restarts / the chat-`done` trigger never double-count; (2) a
 * crafted trajectory replays into rows whose token sums equal the trajectory's
 * model.completed usage EXACTLY (the #483 acceptance oracle).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import {
  insertPerTurnUsage,
  recordSessionTurnsUsage,
  type InsertableUsageRow,
} from "@/lib/usage-per-turn";
import { _resetPricingCacheForTest } from "@/lib/usage";

const AGENT = "agent-pt-1";
const USER = "user-pt-1";
const SESSION_KEY = `agent:${AGENT}:direct:${USER}`.toLowerCase();
const SESSION_ID = "sess-pt-1";

function row(over: Partial<InsertableUsageRow>): InsertableUsageRow {
  return {
    userId: USER,
    agentId: AGENT,
    agentName: "Ada",
    sessionKey: SESSION_KEY,
    model: "anthropic/claude-sonnet-4-6",
    inputTokens: 5,
    outputTokens: 630,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    estimatedCostUsd: null,
    runId: "run-1",
    seq: 5,
    ...over,
  };
}

function modelCompleted(runId: string, seq: number, usage: Record<string, number>) {
  return JSON.stringify({
    type: "model.completed",
    seq,
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    runId,
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    data: { usage },
  });
}

async function rowsForSession() {
  return db.select().from(usageRecords).where(eq(usageRecords.sessionKey, SESSION_KEY));
}

describe("per-turn usage accounting (#483) — real Postgres", () => {
  let stateDir: string;

  beforeEach(async () => {
    _resetPricingCacheForTest();
    await db.delete(usageRecords).where(eq(usageRecords.sessionKey, SESSION_KEY));
    stateDir = mkdtempSync(join(tmpdir(), "pinchy-pt-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
    await db.delete(usageRecords).where(eq(usageRecords.sessionKey, SESSION_KEY));
  });

  it("insertPerTurnUsage dedups by (sessionKey, runId): re-inserting the same turn is a no-op", async () => {
    expect(await insertPerTurnUsage([row({ runId: "r1" })])).toBe(1);
    // Same (sessionKey, runId) again — different token values must NOT create a
    // second row nor overwrite; the unique index swallows it.
    expect(await insertPerTurnUsage([row({ runId: "r1", inputTokens: 999 })])).toBe(0);
    expect(await insertPerTurnUsage([row({ runId: "r2" })])).toBe(1);

    const rows = await rowsForSession();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.runId === "r1")?.inputTokens).toBe(5); // original, not 999
  });

  it("a batch with a duplicate runId among new ones inserts only the new turns", async () => {
    await insertPerTurnUsage([row({ runId: "a" })]);
    const inserted = await insertPerTurnUsage([
      row({ runId: "a" }), // already present
      row({ runId: "b" }),
      row({ runId: "c" }),
    ]);
    expect(inserted).toBe(2);
    expect((await rowsForSession()).map((r) => r.runId).sort()).toEqual(["a", "b", "c"]);
  });

  it("recordSessionTurnsUsage replays a trajectory into exact per-turn rows, idempotently", async () => {
    // Write the OpenClaw session index + a 3-turn trajectory into the temp state dir.
    const dir = join(stateDir, "agents", AGENT, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify({ [SESSION_KEY]: { sessionId: SESSION_ID } })
    );
    writeFileSync(
      join(dir, `${SESSION_ID}.trajectory.jsonl`),
      [
        JSON.stringify({ type: "session.started", seq: 1 }),
        modelCompleted("run-a", 2, {
          input: 5,
          output: 100,
          cacheRead: 1000,
          cacheWrite: 200,
          total: 1305,
        }),
        modelCompleted("run-b", 4, {
          input: 7,
          output: 200,
          cacheRead: 2000,
          cacheWrite: 0,
          total: 2207,
        }),
        modelCompleted("run-c", 6, { input: 3, output: 50, total: 53 }), // no cache
      ].join("\n")
    );

    // Fake OpenClaw client: pricing for the model so cost is also exercised.
    const openclawClient = {
      config: {
        get: async () => ({
          config: {
            models: {
              providers: {
                anthropic: {
                  models: [{ id: "anthropic/claude-sonnet-4-6", cost: { input: 3, output: 15 } }],
                },
              },
            },
          },
        }),
      },
    } as never;

    const inserted = await recordSessionTurnsUsage({
      openclawClient,
      agentId: AGENT,
      userId: USER,
      agentName: "Ada",
      sessionKey: SESSION_KEY,
    });
    expect(inserted).toBe(3);

    const rows = await rowsForSession();
    expect(rows).toHaveLength(3);
    // Exact per-turn token sums == the trajectory's model.completed sums.
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
    expect(sum((r) => r.inputTokens)).toBe(5 + 7 + 3);
    expect(sum((r) => r.outputTokens)).toBe(100 + 200 + 50);
    expect(sum((r) => r.cacheReadTokens)).toBe(1000 + 2000 + 0);
    expect(sum((r) => r.cacheWriteTokens)).toBe(200 + 0 + 0);
    // Cost is populated per turn (run-a: (5*3+100*15+1000*0.3+200*3.75)/1e6).
    const runA = rows.find((r) => r.runId === "run-a")!;
    expect(runA.estimatedCostUsd).toBe("0.002565");
    expect(runA.seq).toBe(2);

    // Idempotent: a second scan of the same trajectory records nothing new.
    const again = await recordSessionTurnsUsage({
      openclawClient,
      agentId: AGENT,
      userId: USER,
      agentName: "Ada",
      sessionKey: SESSION_KEY,
    });
    expect(again).toBe(0);
    expect(await rowsForSession()).toHaveLength(3);
  });
});
