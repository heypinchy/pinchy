import type { WebSocket } from "ws";

/**
 * A server-side record of an in-flight chat run.
 *
 * Why this exists: when the Browser ↔ Pinchy WebSocket dies mid-stream, the
 * Pinchy ↔ OpenClaw connection keeps draining the stream — but nothing on
 * Pinchy knows the run is still going, who owns it, or whether anyone is
 * still listening. `ActiveRun` is the missing piece (issue #310, Tier 2).
 *
 * `sessionKey` is the primary key. We do not key by runId because at the
 * moment a reconnect happens the client knows only the sessionKey — it has
 * no way to discover the runId until the server tells it. One sessionKey
 * has at most one active run at a time: a new user turn replaces the
 * previous run (mirroring OC's own behavior).
 *
 * `listeners` is the set of currently-connected browser WebSockets that
 * should receive chunks for this run. After a reconnect Tier 2b joins the
 * new ws as a listener (see `addListener`); multi-tab support shows up for
 * free here because two tabs on the same session naturally end up in the
 * same set.
 */
export interface ActiveRun {
  runId: string;
  sessionKey: string;
  agentId: string;
  /**
   * Owner of the run. Snapshotted at registration so the watchdog can
   * include `user.id` in the `chat.run_timed_out` audit row even though
   * the watchdog itself acts as `system / watchdog`. PII rules forbid
   * email/name here — operators join against the users table when they
   * need a human-readable name.
   */
  userId: string;
  agentName: string;
  /**
   * Wall-clock time of the FIRST chunk Pinchy observed for this run —
   * not the user-submit time. The 60s client-side stuck timer
   * (`STUCK_TIMEOUT_MS` in `client-router.ts`) covers the "stream
   * never started" case; the watchdog uses `startedAt` to cap runs
   * that DO start but never finish. Effective hard-timeout is therefore
   * "time-to-first-chunk + maxRunDurationMs" — usually a few seconds of
   * overhead on top of the 15-minute default.
   */
  startedAt: number;
  lastChunkAt: number;
  listeners: Set<WebSocket>;
}

/**
 * In-memory registry of active runs, keyed by sessionKey.
 *
 * Lifetime: one instance per Pinchy process. The Tier 2 design explicitly
 * rejects DB persistence — survives in-process disconnects (which is all we
 * need); a Pinchy restart drops everything, which is acceptable because the
 * OpenClaw side is also restarted (or unreachable) in that case.
 *
 * Thread safety: Node is single-threaded, every method here is sync.
 */
export class ActiveRuns {
  private runs = new Map<string, ActiveRun>();

  /**
   * Begin tracking a new run. If a run already exists for this sessionKey
   * (e.g. user sent a new message before the previous one finished),
   * the old entry is discarded — its listeners are no longer reached, which
   * matches the user expectation that the new turn replaces the old one.
   */
  register(input: Omit<ActiveRun, "lastChunkAt" | "listeners"> & { ws: WebSocket }): ActiveRun {
    const { ws, ...rest } = input;
    const run: ActiveRun = {
      ...rest,
      lastChunkAt: rest.startedAt,
      listeners: new Set<WebSocket>([ws]),
    };
    this.runs.set(rest.sessionKey, run);
    return run;
  }

  /**
   * Record activity on this run. Called on every chunk the OC stream
   * produces so the watchdog can distinguish "actually progressing" from
   * "absolutely silent". The watchdog still uses absolute age (startedAt)
   * for the hard timeout — `lastChunkAt` is reserved for future
   * inactivity-based heuristics.
   */
  touch(sessionKey: string, when: number): void {
    const run = this.runs.get(sessionKey);
    if (!run) return;
    run.lastChunkAt = when;
  }

  get(sessionKey: string): ActiveRun | undefined {
    return this.runs.get(sessionKey);
  }

  delete(sessionKey: string): void {
    this.runs.delete(sessionKey);
  }

  /**
   * Attach a second WebSocket as a listener for an existing run. Used by
   * Tier 2b: when a reconnecting browser asks the server "are you still
   * running my last turn?", the server adds the new ws to the set so
   * subsequent chunks broadcast to both. Returns false if no run exists,
   * which tells the caller to reply with "no active run".
   */
  addListener(sessionKey: string, ws: WebSocket): boolean {
    const run = this.runs.get(sessionKey);
    if (!run) return false;
    run.listeners.add(ws);
    return true;
  }

  removeListener(sessionKey: string, ws: WebSocket): void {
    const run = this.runs.get(sessionKey);
    if (!run) return;
    run.listeners.delete(ws);
  }

  /**
   * On WebSocket close: detach the closing ws from every run it was
   * attached to. The runs themselves stay registered — the OC stream is
   * still being drained server-side, and chunks for runs with zero
   * listeners are still consumed (just discarded for the browser). The
   * watchdog tears down the run on absolute timeout.
   */
  removeListenerFromAll(ws: WebSocket): void {
    for (const run of this.runs.values()) {
      run.listeners.delete(ws);
    }
  }

  /**
   * Find runs whose absolute age exceeds the per-run cap. Used by the
   * watchdog (30s interval) to identify stuck runs. The watchdog is
   * responsible for the side effects (abort the OC run, audit the
   * timeout, broadcast an error chunk to listeners, delete from the
   * registry) — this method only reports.
   */
  scanForStuckRuns(now: number, maxRunDurationMs: number): ActiveRun[] {
    const stuck: ActiveRun[] = [];
    for (const run of this.runs.values()) {
      if (now - run.startedAt > maxRunDurationMs) {
        stuck.push(run);
      }
    }
    return stuck;
  }

  size(): number {
    return this.runs.size;
  }

  values(): IterableIterator<ActiveRun> {
    return this.runs.values();
  }
}
