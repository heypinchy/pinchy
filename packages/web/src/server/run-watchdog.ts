import type { ActiveRun, ActiveRuns } from "@/server/active-runs";

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

/**
 * Audit row for a run that was accepted but never produced a first chunk
 * within the first-chunk timeout (B-1) — a wedged/rate-limited lane. This
 * guards a Pinchy-specific dispatch race that OpenClaw itself can't see: a run
 * Pinchy dispatched but the gateway never acknowledged. The absolute-duration
 * cap that used to live here was removed — OpenClaw self-aborts stuck/idle runs
 * (120s idle, ~5min stuck), so a Pinchy-side absolute cap was both redundant
 * AND harmful (it killed slow-but-alive runs). The authoritative liveness
 * signal (`agentWait`) is now the source of truth for run liveness. Same PII
 * rules: only `user.id` in detail.
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

export type WatchdogAuditPayload = NoFirstChunkAuditPayload;

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
   * Broadcast a RETRYABLE error frame for a run that never produced a first
   * chunk (B-1) — "the agent didn't start responding, retry". This case is
   * recoverable (the user can resend). Sync.
   */
  broadcastNoFirstChunk: (run: ActiveRun) => void;
  /** Injected so tests can use a fixed clock. */
  now: () => number;
  /**
   * How long a dispatched run may wait for its first chunk before the
   * watchdog tears it down as `chat.run_no_first_chunk`. Above the dispatch-race
   * retry budget (default 180s) so a never-acknowledged run surfaces without
   * false-aborting a run that's just waiting out an OpenClaw restart.
   */
  firstChunkTimeoutMs: number;
}

/**
 * Run one tick: tear down runs the backend accepted but never streamed a first
 * chunk for (the first-chunk backstop, B-1). Resilient to per-run failures —
 * one run failing to abort doesn't prevent the others from being processed.
 *
 * The absolute-duration cap (15-min `chat.run_timed_out`) that used to also run
 * here was removed: OpenClaw self-aborts stuck/idle runs (120s idle, ~5min
 * stuck), so a Pinchy-side absolute cap was redundant AND harmful — it killed
 * slow-but-alive runs. The first-chunk guard stays because it covers a
 * Pinchy-specific dispatch race OpenClaw can't see (a run Pinchy dispatched but
 * the gateway never acknowledged). Authoritative run liveness now comes from the
 * gateway's `agentWait` oracle (see client-router.ts).
 *
 * Ordering inside the per-run block:
 *   1. writeAudit (await): the audit row must land.
 *   2. chatAbort (try/catch): best-effort. OC may be offline, etc.
 *   3. broadcastNoFirstChunk (sync): inform every listener with a RETRYABLE
 *      error frame.
 *   4. activeRuns.delete: drop the entry.
 *
 * Errors in writeAudit or broadcastNoFirstChunk are logged and swallowed so
 * one failing run can't stop the loop.
 */
export async function runWatchdogTick(deps: WatchdogDeps): Promise<void> {
  // B-1: tear down runs that were accepted but never produced a first chunk
  // within the first-chunk timeout (a wedged/rate-limited lane). A RETRYABLE
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
    // began streaming (OpenClaw now owns liveness for started runs).
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
  // Re-entrancy guard: a tick performs networked awaits (writeAudit, then a
  // chatAbort that can block up to ~30s when OpenClaw is wedged), so a single
  // tick can exceed the interval. Without this, a second tick would start while
  // the first is mid-flight, re-process the same unstarted run, and write a
  // duplicate chat.run_no_first_chunk row plus a redundant abort/broadcast.
  let ticking = false;
  const handle = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void runWatchdogTick(deps)
      .catch((err) => {
        console.error("[run-watchdog] tick failed:", err);
      })
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  // Don't keep the Node process alive solely for the watchdog — important
  // for graceful shutdown and for tests that import this module.
  handle.unref?.();
  return () => clearInterval(handle);
}
