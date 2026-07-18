/**
 * Token + cost capture for Eval-v1 (pinchy#798).
 *
 * A measured pass/fail says nothing about what a task COST to attempt. This
 * joins each run to its `usage_records` rows and rolls them up into the
 * {@link RunTokenUsage} attached to the graded result, so the benchmark can
 * publish tokens-per-completed-task (its primary cost metric) and surface the
 * peak context-window pressure that precedes false-success (the "Piper"
 * incident, #798).
 *
 * The join is EXACT, not a time window: `dispatchAndScrape` mints a fresh
 * `chatId` per run, so the run occupies a unique OpenClaw session
 * `agent:<agentId>:direct:<userId>:<chatId>`, and every `usage_records` row for
 * that session_key belongs to exactly this run. Summing them gives the whole
 * tool loop's cost, not one call's.
 *
 * The recorder lags the run (the chat `done` path kicks it, a poller backstops
 * it), so the collector POLLS until the row count is stable — reading once,
 * mid-write, would undercount a multi-turn run. Everything here is best-effort:
 * a missing recorder, a DB blip, or a run that produced no turn at all yields
 * `undefined` rather than aborting a 15-hour sweep.
 */
import type { Sql } from "postgres";
import type { RunTokenUsage } from "../src/lib/eval/types";

/**
 * One `usage_records` row as read for the join. `estimated_cost_usd` is a
 * `numeric` column, so postgres.js hands it back as a string (or null); the
 * token columns are integers, `context_tokens` nullable. `input`, `cacheRead`
 * and `cacheWrite` are the three DISJOINT prompt classes (see
 * usage-from-trajectory.ts) — all tokens the model read, differing only in
 * billing — so the run's prompt volume is their sum.
 */
export interface UsageRow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number | null;
  estimatedCostUsd: string | null;
}

/**
 * Rolls up a run's `usage_records` rows into a {@link RunTokenUsage}. Pure.
 * - `prompt`: summed over every turn, counting all three prompt classes
 *   (`input + cacheRead + cacheWrite`) so caching hosters aren't under-reported.
 * - `completion`: summed output over every turn (the task's total cost).
 * - `contextTokens`: the PEAK (max) across turns, ignoring nulls — window
 *   pressure, not a total. Omitted when no turn recorded it.
 * - `costUsd`: summed parsed cost. Omitted when no turn priced per token.
 *
 * Returns `undefined` for an empty set — the run has no usage data, distinct
 * from a run that cost zero.
 */
export function aggregateTokenUsage(rows: UsageRow[]): RunTokenUsage | undefined {
  if (rows.length === 0) return undefined;

  let prompt = 0;
  let completion = 0;
  let peakContext: number | undefined;
  let costUsd: number | undefined;

  for (const r of rows) {
    prompt += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    completion += r.outputTokens;
    if (r.contextTokens !== null) {
      peakContext =
        peakContext === undefined ? r.contextTokens : Math.max(peakContext, r.contextTokens);
    }
    if (r.estimatedCostUsd !== null) {
      const parsed = Number(r.estimatedCostUsd);
      if (Number.isFinite(parsed)) costUsd = (costUsd ?? 0) + parsed;
    }
  }

  const usage: RunTokenUsage = { prompt, completion };
  if (peakContext !== undefined) usage.contextTokens = peakContext;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

export interface CollectTokensOptions {
  /** Give up polling after this long; return best-effort. Default 20s. */
  timeoutMs?: number;
  /** Delay between polls. Default 500ms. */
  intervalMs?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
  /** Injectable delay (tests). Default a real `setTimeout` sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called when the join query throws. The result still degrades to
   * `undefined` (a DB blip must never abort the sweep), but a THROWN query is a
   * systemic break — a renamed column, a session-key convention drift — that
   * would otherwise capture nothing for the whole sweep, indistinguishable from
   * "this provider is subscription-billed". `makeTokenCollector` uses this to
   * warn once so the break is visible in the logs rather than fully silent.
   */
  onQueryError?: (err: unknown) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `query` until the row count is non-empty AND unchanged since the
 * previous read (the recorder has finished writing this run's turns), then
 * returns the aggregate. Count-stability is a sound "done" signal because the
 * recorder writes a run's turns in ONE atomic batch insert (see
 * `insertPerTurnUsage`) and the collector only runs after the run is idle, so
 * the count steps 0 → N → N and never settles on a partial N. Best-effort on
 * the edges:
 * - No rows before `timeoutMs` → `undefined` (run recorded no usage).
 * - Rows that never stabilize before `timeoutMs` → the last aggregate seen,
 *   rather than discarding a partial count.
 * - A query that throws → `undefined`, so a DB blip never aborts the sweep.
 */
export async function collectRunTokens(
  query: () => Promise<UsageRow[]>,
  opts: CollectTokensOptions = {}
): Promise<RunTokenUsage | undefined> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 500;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;

  const deadline = now() + timeoutMs;
  let prevCount = -1;
  let lastAggregate: RunTokenUsage | undefined;

  for (;;) {
    let rows: UsageRow[];
    try {
      rows = await query();
    } catch (err) {
      opts.onQueryError?.(err);
      return undefined;
    }

    if (rows.length > 0 && rows.length === prevCount) {
      // Stable: the recorder is done writing this run's turns.
      return aggregateTokenUsage(rows);
    }
    prevCount = rows.length;
    lastAggregate = aggregateTokenUsage(rows);

    if (now() >= deadline) return lastAggregate;
    await sleep(intervalMs);
  }
}

/** Joins one run to its tokens by (agentId, chatId). Injected into `runOnce`. */
export type TokenCollector = (
  agentId: string,
  chatId: string
) => Promise<RunTokenUsage | undefined>;

/**
 * Builds a {@link TokenCollector} over a live postgres client. The DB coupling
 * lives here (and in the sweep spec that owns the connection), keeping
 * `run-eval.ts` free of a DB driver — it reaches everything else over HTTP.
 *
 * The session_key filter anchors on both the agent prefix and the run's unique
 * chatId suffix (`agent:<agentId>:direct:%:<chatId>`), so the `%` only spans the
 * userId segment and the rows are exactly this run's. The pattern is
 * lower-cased because `usage_records.session_key` is written lower-cased (see
 * `lib/usage.ts` / `lib/usage-per-turn.ts`); matching the raw mixed-case id
 * would silently return nothing.
 *
 * A thrown join query (renamed column, convention drift) degrades to no tokens
 * — but is warned ONCE per sweep so a systemic break is visible in the logs
 * rather than fully silent (a captured-nothing sweep looks identical to a
 * subscription-billed one otherwise).
 */
export function makeTokenCollector(sql: Sql, opts: CollectTokensOptions = {}): TokenCollector {
  let warnedQueryError = false;
  const onQueryError =
    opts.onQueryError ??
    ((err: unknown) => {
      if (warnedQueryError) return;
      warnedQueryError = true;
      console.warn(
        `[eval] token join query failed — capturing no per-run cost for this sweep: ${String(err)}`
      );
    });

  return (agentId, chatId) => {
    const pattern = `agent:${agentId}:direct:%:${chatId}`.toLowerCase();
    const query = async (): Promise<UsageRow[]> => {
      const rows = await sql<UsageRow[]>`
        SELECT input_tokens        AS "inputTokens",
               output_tokens       AS "outputTokens",
               cache_read_tokens   AS "cacheReadTokens",
               cache_write_tokens  AS "cacheWriteTokens",
               context_tokens      AS "contextTokens",
               estimated_cost_usd  AS "estimatedCostUsd"
        FROM usage_records
        WHERE agent_id = ${agentId}
          AND session_key LIKE ${pattern}
      `;
      return [...rows];
    };
    return collectRunTokens(query, { ...opts, onQueryError });
  };
}
