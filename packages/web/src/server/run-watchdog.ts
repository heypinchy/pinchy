import type { ActiveRun, ActiveRuns } from "@/server/active-runs";

/**
 * Default per-run hard timeout. After this much absolute wall-clock time
 * the watchdog tears the run down regardless of activity.
 *
 * Rationale: OpenAI's hosted Assistants API uses 10 min, Anthropic's
 * Claude Agent SDK uses ~10 min for streaming. We pick 15 min because
 * Pinchy's workload mix (local Ollama, KB-agents with PDF vision,
 * air-gapped deployments) is meaningfully slower than the hosted-only
 * profile those numbers are calibrated for. See #310 Tier 2 decision #9.
 *
 * No per-agent override in v0.6.0 (YAGNI) — surface as a per-deployment
 * env-var if we ever see a legitimate use case.
 */
export const DEFAULT_MAX_RUN_DURATION_MS = 15 * 60 * 1000;

/** Watchdog scan cadence — every 30 seconds. */
export const WATCHDOG_INTERVAL_MS = 30_000;

/**
 * Default first-chunk timeout (B-1). A run that never produces a first chunk
 * (OpenClaw's `userMessagePersisted` acknowledgement) within this window is
 * torn down as `chat.run_no_first_chunk` with a RETRYABLE error.
 *
 * MUST exceed the dispatch-race retry budget (`chat-dispatch-retry.ts`
 * `maxTotalMs`, currently 150s): while OpenClaw is mid-restart, that wrapper
 * legitimately retries a failing dispatch ("unknown agent id") for up to 150s
 * before the run is ever accepted — the run is `registerPending`-ed but
 * produces no first chunk for that whole window. A timeout below 150s would
 * falsely abort a run that is simply waiting out an OC restart. 180s clears
 * the 150s budget with a margin; the client-side 60s stuck timer still gives
 * the open-tab fast-retry path, so this longer value only affects the durable,
 * reload-surviving backstop. The 30s scan cadence means effective granularity
 * is ~180–210s.
 */
export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 180_000;

export interface AuditPayload {
  actorType: "system";
  actorId: "watchdog";
  eventType: "chat.run_timed_out";
  resource: string;
  outcome: "failure";
  detail: {
    agent: { id: string; name: string };
    // The user whose run was forcibly terminated. We snapshot just the id
    // (no email/name) because the audit trail forbids PII in detail and
    // the user record may still be queryable for richer joining later.
    user: { id: string };
    sessionKey: string;
    runId: string;
    elapsedMs: number;
    maxRunDurationMs: number;
  };
}

/**
 * Audit row for a run that was accepted but never produced a first chunk
 * within the first-chunk timeout (B-1) — a wedged/rate-limited lane. Distinct
 * from `chat.run_timed_out` (a run that started but never finished) so an
 * analyst can tell "the backend never started responding" apart from "the
 * backend started but ran long". Same PII rules: only `user.id` in detail.
 */
export interface NoFirstChunkAuditPayload {
  actorType: "system";
  actorId: "watchdog";
  eventType: "chat.run_no_first_chunk";
  resource: string;
  outcome: "failure";
  detail: {
    agent: { id: string; name: string };
    user: { id: string };
    sessionKey: string;
    runId: string;
    /** Wall-clock the run waited for its first chunk before being torn down. */
    waitedMs: number;
    firstChunkTimeoutMs: number;
  };
}

export type WatchdogAuditPayload = AuditPayload | NoFirstChunkAuditPayload;

export interface WatchdogDeps {
  activeRuns: ActiveRuns;
  /**
   * Abort the OpenClaw-side run. Implementations should swallow internal
   * errors and resolve (or throw — the watchdog catches and continues).
   */
  chatAbort: (sessionKey: string, runId: string) => Promise<void>;
  /**
   * Write the terminal audit row. The watchdog awaits this BEFORE the
   * broadcast and registry-delete so a forwarding error can't lose the
   * audit trail.
   */
  writeAudit: (entry: WatchdogAuditPayload) => Promise<void>;
  /**
   * Broadcast a terminal error frame to every connected listener so the
   * user sees a "Timed out after 15m 0s" bubble instead of an indefinite
   * spinner. Sync — listeners take whatever side effect they want.
   */
  broadcastTimeout: (run: ActiveRun) => void;
  /**
   * Broadcast a RETRYABLE error frame for a run that never produced a first
   * chunk (B-1) — "the agent didn't start responding, retry". Separate from
   * `broadcastTimeout` because this case is recoverable (the user can resend)
   * whereas the 15-min absolute timeout is terminal. Sync.
   */
  broadcastNoFirstChunk: (run: ActiveRun) => void;
  /** Injected so tests can use a fixed clock. */
  now: () => number;
  maxRunDurationMs: number;
  /**
   * How long a dispatched run may wait for its first chunk before the
   * watchdog tears it down as `chat.run_no_first_chunk`. Far shorter than the
   * `maxRunDurationMs` absolute cap, but above the dispatch-race retry budget
   * (default 180s) so a never-acknowledged run surfaces without false-aborting
   * a run that's just waiting out an OpenClaw restart.
   */
  firstChunkTimeoutMs: number;
}

/**
 * Run one tick: scan for stuck runs and tear them down. Resilient to
 * per-run failures — one stuck run failing to abort doesn't prevent the
 * others from being processed.
 *
 * Ordering inside the per-run block:
 *   1. writeAudit (await): the audit row must land. This is the closest
 *      thing to a compliance signal we have for "your agent run was
 *      forcibly terminated by the system".
 *   2. chatAbort (try/catch): best-effort. OC may be offline, the run may
 *      already be over server-side, etc. Either way we don't block the
 *      rest of the work.
 *   3. broadcastTimeout (sync): inform every listener.
 *   4. activeRuns.delete: drop the entry.
 *
 * Errors in writeAudit or broadcastTimeout are logged and swallowed so
 * one failing run can't stop the loop.
 */
export async function runWatchdogTick(deps: WatchdogDeps): Promise<void> {
  const stuck = deps.activeRuns.scanForStuckRuns(deps.now(), deps.maxRunDurationMs);
  for (const run of stuck) {
    const elapsedMs = deps.now() - run.startedAt;
    const audit: AuditPayload = {
      actorType: "system",
      actorId: "watchdog",
      eventType: "chat.run_timed_out",
      resource: `agent:${run.agentId}`,
      outcome: "failure",
      detail: {
        agent: { id: run.agentId, name: run.agentName },
        user: { id: run.userId },
        sessionKey: run.sessionKey,
        runId: run.runId,
        elapsedMs,
        maxRunDurationMs: deps.maxRunDurationMs,
      },
    };
    try {
      await deps.writeAudit(audit);
    } catch (err) {
      // Audit failure must never stop the loop — recordAuditFailure on
      // the caller side already preserves the gap signal. Logging here
      // is a belt to that suspenders.
      console.error("[run-watchdog] writeAudit failed:", err);
    }
    try {
      await deps.chatAbort(run.sessionKey, run.runId);
    } catch (err) {
      console.warn(
        `[run-watchdog] chatAbort failed for ${run.sessionKey} (run ${run.runId}):`,
        err
      );
    }
    // Re-check after the (networked) abort await: a resend may have replaced
    // this run on the same session. Don't broadcast A's timeout to B's tab or
    // delete B's entry.
    if (deps.activeRuns.get(run.sessionKey) !== run) continue;
    try {
      deps.broadcastTimeout(run);
    } catch (err) {
      console.error("[run-watchdog] broadcastTimeout failed:", err);
    }
    deps.activeRuns.deleteIfRunId(run.sessionKey, run.runId);
  }

  // B-1: tear down runs that were accepted but never produced a first chunk
  // within the first-chunk timeout (a wedged/rate-limited lane). Same ordering
  // and per-run resilience as the absolute-timeout loop above, but a RETRYABLE
  // broadcast and a distinct audit event — the user can resend, and operators
  // get a forensic row for "the backend never started responding".
  const unstarted = deps.activeRuns.scanForUnstartedRuns(deps.now(), deps.firstChunkTimeoutMs);
  for (const run of unstarted) {
    // Re-check before doing anything: a first chunk may have reconciled this
    // run (or a newer turn replaced it) during a PRIOR iteration's awaits.
    if (deps.activeRuns.get(run.sessionKey) !== run || run.firstChunkAt !== null) continue;
    const waitedMs = deps.now() - run.submittedAt;
    const audit: NoFirstChunkAuditPayload = {
      actorType: "system",
      actorId: "watchdog",
      eventType: "chat.run_no_first_chunk",
      resource: `agent:${run.agentId}`,
      outcome: "failure",
      detail: {
        agent: { id: run.agentId, name: run.agentName },
        user: { id: run.userId },
        sessionKey: run.sessionKey,
        runId: run.runId,
        waitedMs,
        firstChunkTimeoutMs: deps.firstChunkTimeoutMs,
      },
    };
    try {
      await deps.writeAudit(audit);
    } catch (err) {
      console.error("[run-watchdog] writeAudit (no_first_chunk) failed:", err);
    }
    // Re-check after the audit await: a real first chunk may have started the
    // run while the audit was in flight — don't abort/notify a run that just
    // began streaming (leave it to the absolute 15-min cap instead).
    if (deps.activeRuns.get(run.sessionKey) !== run || run.firstChunkAt !== null) continue;
    try {
      await deps.chatAbort(run.sessionKey, run.runId);
    } catch (err) {
      console.warn(
        `[run-watchdog] chatAbort (no_first_chunk) failed for ${run.sessionKey} (run ${run.runId}):`,
        err
      );
    }
    // Re-check after the (networked) abort await: a resend may have replaced
    // this run (the first-chunk timeout is exactly when a blank-thread user resends).
    // Don't broadcast A's "didn't start" error to B's tab or delete B's entry.
    if (deps.activeRuns.get(run.sessionKey) !== run || run.firstChunkAt !== null) continue;
    try {
      deps.broadcastNoFirstChunk(run);
    } catch (err) {
      console.error("[run-watchdog] broadcastNoFirstChunk failed:", err);
    }
    deps.activeRuns.deleteIfRunId(run.sessionKey, run.runId);
  }
}

/**
 * Start the watchdog loop. Returns a stop fn that clears the interval.
 * The custom server should call this once after the OpenClaw client is
 * initialized and call stop on shutdown.
 */
export function startRunWatchdog(
  deps: WatchdogDeps,
  intervalMs: number = WATCHDOG_INTERVAL_MS
): () => void {
  const handle = setInterval(() => {
    void runWatchdogTick(deps).catch((err) => {
      console.error("[run-watchdog] tick failed:", err);
    });
  }, intervalMs);
  // Don't keep the Node process alive solely for the watchdog — important
  // for graceful shutdown and for tests that import this module.
  handle.unref?.();
  return () => clearInterval(handle);
}
