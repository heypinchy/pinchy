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

export interface AuditPayload {
  actorType: "system";
  actorId: "watchdog";
  eventType: "chat.run_timed_out";
  resource: string;
  outcome: "failure";
  detail: {
    agent: { id: string; name: string };
    sessionKey: string;
    runId: string;
    elapsedMs: number;
    maxRunDurationMs: number;
  };
}

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
  writeAudit: (entry: AuditPayload) => Promise<void>;
  /**
   * Broadcast a terminal error frame to every connected listener so the
   * user sees a "Timed out after 15m 0s" bubble instead of an indefinite
   * spinner. Sync — listeners take whatever side effect they want.
   */
  broadcastTimeout: (run: ActiveRun) => void;
  /** Injected so tests can use a fixed clock. */
  now: () => number;
  maxRunDurationMs: number;
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
    try {
      deps.broadcastTimeout(run);
    } catch (err) {
      console.error("[run-watchdog] broadcastTimeout failed:", err);
    }
    deps.activeRuns.delete(run.sessionKey);
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
