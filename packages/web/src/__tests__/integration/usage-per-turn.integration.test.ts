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
    contextTokens: null,
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
                // Bare id, exactly as openclaw-config/build.ts emits it. This
                // fixture used to say "anthropic/claude-sonnet-4-6" — a shape
                // the real config never produces — which made the pricing
                // lookup match for the wrong reason and hid the fact that the
                // per-turn path asks with a qualified id.
                anthropic: {
                  models: [{ id: "claude-sonnet-4-6", cost: { input: 3, output: 15 } }],
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

// #767: system sessions (cron/channel/main/hook) were left on a separate
// gauge-delta path under the belief that they have "no per-user trajectory to
// scan" — verified false in production, so the poller now routes them through
// the SAME recorder as chat sessions. Real Postgres proves the two things a
// faked DB cannot for this migration: (1) a pre-existing gauge-poller row
// (run_id/context_tokens NULL, written before this change shipped) is left
// untouched — the unique index's NULLS DISTINCT means it never collides with
// a real run_id; (2) the newly-scanned trajectory turn gets its own row with
// run_id + context_tokens populated, without double-counting the old row.
describe("per-turn usage accounting for SYSTEM sessions (#767) — real Postgres", () => {
  const AGENT = "agent-pt-sys-1";
  const SESSION_KEY = `agent:${AGENT}:cron:job-1`.toLowerCase();
  const SESSION_ID = "sess-pt-sys-1";

  let stateDir: string;

  async function rowsForSession() {
    return db.select().from(usageRecords).where(eq(usageRecords.sessionKey, SESSION_KEY));
  }

  function fakeOpenclawClient() {
    return {
      config: { get: async () => ({ config: { models: { providers: {} } } }) },
    } as never;
  }

  beforeEach(async () => {
    _resetPricingCacheForTest();
    await db.delete(usageRecords).where(eq(usageRecords.sessionKey, SESSION_KEY));
    stateDir = mkdtempSync(join(tmpdir(), "pinchy-pt-sys-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
    await db.delete(usageRecords).where(eq(usageRecords.sessionKey, SESSION_KEY));
  });

  it("routes a system session through the trajectory recorder and gives it context_tokens", async () => {
    const dir = join(stateDir, "agents", AGENT, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify({ [SESSION_KEY]: { sessionId: SESSION_ID } })
    );
    writeFileSync(
      join(dir, `${SESSION_ID}.trajectory.jsonl`),
      JSON.stringify({
        type: "model.completed",
        runId: "run-sys-1",
        seq: 2,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        data: {
          usage: { input: 20, output: 40, total: 60 },
          promptCache: { lastCallUsage: { input: 20, output: 40, cacheRead: 0, cacheWrite: 0 } },
        },
      })
    );

    const inserted = await recordSessionTurnsUsage({
      openclawClient: fakeOpenclawClient(),
      agentId: AGENT,
      userId: "system",
      agentName: "Cron Runner",
      sessionKey: SESSION_KEY,
    });
    expect(inserted).toBe(1);

    const rows = await rowsForSession();
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe("run-sys-1");
    expect(rows[0].userId).toBe("system");
    expect(rows[0].contextTokens).toBe(20);
  });

  it("does not double-count or corrupt a pre-existing gauge row once the trajectory path scans the same system session (migration)", async () => {
    // Simulate the PRE-EXISTING state: an old gauge-poller row for this
    // system session, written with the shape recordUsage() always inserted —
    // run_id/seq/context_tokens all NULL. This row predates #767 and must
    // survive the switch untouched.
    await db.insert(usageRecords).values({
      userId: "system",
      agentId: AGENT,
      agentName: "Cron Runner",
      sessionKey: SESSION_KEY,
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: null,
      // runId / seq / contextTokens intentionally omitted — NULL, the
      // pre-#767 gauge shape.
    });

    const preExisting = await rowsForSession();
    expect(preExisting).toHaveLength(1);
    expect(preExisting[0].runId).toBeNull();
    expect(preExisting[0].contextTokens).toBeNull();

    // A NEW turn now completes and gets scanned by the (post-#767) trajectory
    // path — a different turn from whatever the old gauge row summed.
    const dir = join(stateDir, "agents", AGENT, "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify({ [SESSION_KEY]: { sessionId: SESSION_ID } })
    );
    writeFileSync(
      join(dir, `${SESSION_ID}.trajectory.jsonl`),
      JSON.stringify({
        type: "model.completed",
        runId: "run-sys-new",
        seq: 1,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        data: {
          usage: { input: 30, output: 15, total: 45 },
          promptCache: { lastCallUsage: { input: 30, output: 15, cacheRead: 0, cacheWrite: 0 } },
        },
      })
    );

    const inserted = await recordSessionTurnsUsage({
      openclawClient: fakeOpenclawClient(),
      agentId: AGENT,
      userId: "system",
      agentName: "Cron Runner",
      sessionKey: SESSION_KEY,
    });
    expect(inserted).toBe(1);

    // Both rows coexist: the old NULL-run_id gauge row (untouched — the
    // dedup index is NULLS DISTINCT, so it never collides with a real run_id)
    // AND the new trajectory row with run_id + context_tokens populated.
    const rows = await rowsForSession();
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.runId === null);
    const newRow = rows.find((r) => r.runId === "run-sys-new");
    expect(oldRow).toBeDefined();
    expect(oldRow?.inputTokens).toBe(500);
    expect(oldRow?.contextTokens).toBeNull();
    expect(newRow).toBeDefined();
    expect(newRow?.inputTokens).toBe(30);
    expect(newRow?.contextTokens).toBe(30);

    // Re-scanning is idempotent — no third row appears.
    const again = await recordSessionTurnsUsage({
      openclawClient: fakeOpenclawClient(),
      agentId: AGENT,
      userId: "system",
      agentName: "Cron Runner",
      sessionKey: SESSION_KEY,
    });
    expect(again).toBe(0);
    expect(await rowsForSession()).toHaveLength(2);
  });
});
