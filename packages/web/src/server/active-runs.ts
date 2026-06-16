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
   * Owner of the run. Snapshotted at registration so the watchdog can include
   * `user.id` in the `chat.run_no_first_chunk` audit row even though the
   * watchdog itself acts as `system / watchdog`. PII rules forbid email/name
   * here — operators join against the users table when they need a
   * human-readable name.
   */
  userId: string;
  agentName: string;
  /**
   * Wall-clock time the run started streaming (its first chunk). For a
   * dispatch-time pending run this is seeded to the submit time and re-anchored
   * to the real first-chunk time by `markFirstChunk`. Once a run starts, its
   * liveness is owned by OpenClaw (which self-aborts stuck/idle runs) and the
   * authoritative `agentWait` oracle — Pinchy no longer caps started-run
   * duration. The complementary "stream never started" case is the server-side
   * first-chunk backstop: `firstChunkAt === null` + `scanForUnstartedRuns` (B-1).
   */
  startedAt: number;
  /**
   * When this run was registered with Pinchy. For dispatch-time registration
   * (`registerPending`) this is the user-submit time; for the legacy
   * first-chunk `register()` it equals `startedAt`. The first-chunk backstop
   * (`scanForUnstartedRuns`) measures the wait-for-first-chunk from here, so
   * it stays anchored to submit time even after `startedAt` is re-anchored to
   * the real first-chunk time.
   */
  submittedAt: number;
  /**
   * Wall-clock time of the first chunk Pinchy observed, or `null` while the
   * run is still pending — dispatched/accepted but the backend has not
   * streamed anything yet (e.g. a wedged or rate-limited lane). The watchdog
   * uses `firstChunkAt === null` past the first-chunk timeout to tear down a
   * run that never started responding (B-1), so the user gets a retryable
   * error instead of an indefinitely blank thread.
   */
  firstChunkAt: number | null;
  lastChunkAt: number;
  /**
   * Pinchy-side per-turn message id (rotated on each `done`). Stored here so
   * Tier 2b's reconnect-resume path can tell the client which message in
   * the history snapshot the in-flight chunks should be merged into. Chunks
   * arriving on the broadcast carry this same id; the client uses
   * `activeRun.messageId` from the history frame to anchor them to the
   * matching message after reconcile.
   */
  currentMessageId: string;
  /**
   * The assistant text Pinchy has emitted to clients for `currentMessageId` so
   * far (Tier 2b resume completeness). Streaming chunks are DELTAS: after a
   * reload the server resumes broadcasting from the current position and never
   * replays earlier deltas, and OpenClaw may not have persisted the in-flight
   * partial into history yet — so without this buffer the words streamed before
   * the reload are lost. On reconnect the server hands this back as
   * `activeRun.partialContent`; the client seeds the anchored assistant bubble
   * with it, then appends future deltas. Reset to "" on each per-turn messageId
   * rotation (the completed turn is now in OpenClaw history). Kept in sync via
   * `setContent` against the pipe's local accumulator, so it stays correct even
   * if early text streamed before the run was registered.
   */
  currentContent: string;
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
   * Register an already-STARTED run directly (`firstChunkAt` set immediately).
   * The live chat path no longer calls this — it registers at dispatch via
   * `registerPending` and flips to "started" via `markFirstChunk` (B-1).
   * `register` remains the atomic "a started run exists" primitive, used by
   * tests and available for any synchronous already-started registration.
   *
   * If a run already exists for this sessionKey (a new turn supersedes an
   * unfinished one), the old entry is discarded — its listeners are no longer
   * reached, matching the expectation that the new turn replaces the old one.
   */
  register(
    input: Omit<
      ActiveRun,
      "lastChunkAt" | "listeners" | "currentContent" | "submittedAt" | "firstChunkAt"
    > & {
      ws: WebSocket;
      currentContent?: string;
    }
  ): ActiveRun {
    const { ws, currentContent, ...rest } = input;
    const run: ActiveRun = {
      ...rest,
      currentContent: currentContent ?? "",
      // The legacy path registers ON the first chunk, so the run is already
      // "started": submittedAt == startedAt and firstChunkAt is set, which
      // keeps it out of `scanForUnstartedRuns` (it is not pending).
      submittedAt: rest.startedAt,
      firstChunkAt: rest.startedAt,
      lastChunkAt: rest.startedAt,
      listeners: new Set<WebSocket>([ws]),
    };
    this.runs.set(rest.sessionKey, run);
    return run;
  }

  /**
   * Begin tracking a run at DISPATCH time, before any chunk has streamed
   * (B-1). The run is "pending": `firstChunkAt` is null and the absolute
   * `startedAt` cap is seeded to the submit time as a backstop. When the
   * backend finally streams its first chunk, `markFirstChunk` reconciles the
   * provisional runId to the real one and flips the run to "started". If the
   * first chunk never arrives, `scanForUnstartedRuns` lets the watchdog tear
   * the run down with a retryable error instead of leaving a blank thread.
   *
   * Like `register`, this replaces any prior run for the same sessionKey.
   */
  registerPending(
    input: Omit<
      ActiveRun,
      "lastChunkAt" | "listeners" | "firstChunkAt" | "startedAt" | "currentContent"
    > & {
      ws: WebSocket;
    }
  ): ActiveRun {
    const { ws, ...rest } = input;
    const run: ActiveRun = {
      ...rest,
      // A pending run has streamed nothing yet; the resume buffer (#470) starts
      // empty and fills via `setContent` once the first chunk lands (B-1 merge).
      currentContent: "",
      startedAt: rest.submittedAt,
      firstChunkAt: null,
      lastChunkAt: rest.submittedAt,
      listeners: new Set<WebSocket>([ws]),
    };
    this.runs.set(rest.sessionKey, run);
    return run;
  }

  /**
   * Reconcile a pending run on the first chunk that carries the real runId:
   * record `firstChunkAt`, re-anchor `startedAt`/`lastChunkAt` to the
   * first-chunk time (so the 15-min absolute cap matches the legacy
   * semantics), and swap the provisional runId for the real one. Returns
   * false when no run exists for the sessionKey. For the live chat path — the
   * only caller, always preceded by `registerPending` — false means the
   * watchdog already tore the pending run down on the first-chunk timeout, so
   * the caller bails instead of resurrecting the entry (C-1).
   */
  markFirstChunk(sessionKey: string, when: number, runId: string): boolean {
    const run = this.runs.get(sessionKey);
    if (!run) return false;
    run.firstChunkAt = when;
    run.startedAt = when;
    run.lastChunkAt = when;
    run.runId = runId;
    return true;
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

  /**
   * Rotate `currentMessageId` for Tier 2b. Called from `pipeStream` right
   * after the per-turn messageId rotation on every `done` chunk, so the
   * registry always reflects the in-flight turn's id. A reconnecting
   * client reading `activeRun.messageId` from the history frame uses this
   * value to anchor incoming chunks to the right assistant message.
   */
  updateMessageId(sessionKey: string, messageId: string): void {
    const run = this.runs.get(sessionKey);
    if (!run) return;
    run.currentMessageId = messageId;
    // A new per-turn message starts with no emitted text. The just-finished
    // turn is now persisted in OpenClaw history, so a reconnecting client gets
    // it from history rather than from the resume buffer.
    run.currentContent = "";
  }

  /**
   * Sync the accumulated emitted text for the current message. Called from the
   * stream pipe against its local accumulator on every emitted chunk, so the
   * registry mirrors exactly what clients have received — the source of truth
   * for `activeRun.partialContent` on reconnect.
   */
  setContent(sessionKey: string, content: string): void {
    const run = this.runs.get(sessionKey);
    if (!run) return;
    run.currentContent = content;
  }

  get(sessionKey: string): ActiveRun | undefined {
    return this.runs.get(sessionKey);
  }

  delete(sessionKey: string): void {
    this.runs.delete(sessionKey);
  }

  /**
   * Delete the run for `sessionKey` only if it is still the run identified by
   * `runId`. Used by pipeStream's cleanup so a finishing run never clobbers a
   * NEWER run that already replaced it on the same session (rapid resend). The
   * `runId` is the real runId once reconciled, or the provisional dispatch-time
   * id while the run is still pending. Idempotent.
   */
  deleteIfRunId(sessionKey: string, runId: string): void {
    const run = this.runs.get(sessionKey);
    if (run && run.runId === runId) this.runs.delete(sessionKey);
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
   * Find PENDING runs (registered at dispatch, no first chunk yet) whose wait
   * since `submittedAt` exceeds the first-chunk timeout. Used by the watchdog
   * (B-1) to tear down a run the backend accepted but never streamed — e.g. a
   * wedged or rate-limited lane. This guards a Pinchy-specific dispatch race
   * OpenClaw can't see; once a run starts streaming, OpenClaw owns its liveness
   * (it self-aborts stuck/idle runs) and the authoritative `agentWait` oracle is
   * the source of truth. A run that has produced any chunk (`firstChunkAt !==
   * null`) is never returned here.
   */
  scanForUnstartedRuns(now: number, firstChunkTimeoutMs: number): ActiveRun[] {
    const unstarted: ActiveRun[] = [];
    for (const run of this.runs.values()) {
      if (run.firstChunkAt === null && now - run.submittedAt > firstChunkTimeoutMs) {
        unstarted.push(run);
      }
    }
    return unstarted;
  }

  size(): number {
    return this.runs.size;
  }

  values(): IterableIterator<ActiveRun> {
    return this.runs.values();
  }
}
