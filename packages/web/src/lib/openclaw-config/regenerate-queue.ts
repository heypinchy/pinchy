// One `regenerateOpenClawConfig` at a time, with rerun-if-dirty.
//
// A regenerate reads the DB, writes secrets.json, and pushes openclaw.json.
// Two of them running concurrently is a race nobody wins on purpose: a slow
// one that read OLD rows (a discovery call against a slow endpoint is enough)
// can finish after a newer one and write last, leaving stale config live — and
// with versioned key slots, secrets.json and openclaw.json can end up naming
// different versions of a provider's key. The push generation in write.ts
// only orders pushes by when they were *started*, which is exactly the wrong
// order here: the stale run starts its push last.
//
// So runs are serialized. A call while nothing runs starts one immediately. A
// call while one runs marks the queue dirty and waits for the NEXT run — one
// that starts after the current one finishes, and therefore after the call.
// Every caller keeps the guarantee it had with an unserialized regenerate: when
// its await returns, a regenerate that read the DB after the call has
// completed. Any number of calls during one run share that single rerun.
//
// A caller hears the outcome of the run it waited for: a failure rejects the
// callers of that run only, and never wedges the queue.
//
// The state lives on globalThis for the same reason push-state.ts does: this
// module is loaded twice in one Pinchy process (custom server via tsx, and
// Next's route bundles). A module-level queue would give each instance a
// private one, and a route regenerate would run alongside a server one.

/** Callers waiting for the run after the current one. */
interface Rerun {
  promise: Promise<void>;
  /** Settles `promise` with the outcome of the run it is handed. */
  settleWith: (run: Promise<void>) => void;
}

export interface RegenerateQueueState {
  /** The run in flight, or null when idle. */
  running: Promise<void> | null;
  /** Set when calls arrived during `running`; started the moment it settles. */
  rerun: Rerun | null;
}

declare global {
  var __pinchyRegenerateQueue: RegenerateQueueState | undefined;
}

/**
 * Test-only: start the next regenerate from an idle queue. A test that fails
 * while it holds a run open would otherwise leave that run "in flight" for the
 * rest of the file, and every later regenerate would queue behind it until it
 * timed out. A run still settling keeps its reference to the old state, so it
 * cannot reach the fresh one. Do not call in app code.
 */
export function _resetRegenerateQueue(): void {
  globalThis.__pinchyRegenerateQueue = { running: null, rerun: null };
}

function globalQueueState(): RegenerateQueueState {
  globalThis.__pinchyRegenerateQueue ??= { running: null, rerun: null };
  return globalThis.__pinchyRegenerateQueue;
}

/**
 * Wrap `run` so that at most one invocation is in flight, and a call made
 * during one resolves only after a run that STARTED after the call has
 * completed. `getState` is injectable for tests; production uses the
 * process-wide queue.
 */
export function serializeRegenerates(
  run: () => Promise<void>,
  getState: () => RegenerateQueueState = globalQueueState
): () => Promise<void> {
  const start = (state: RegenerateQueueState): Promise<void> => {
    // Invoked synchronously; a synchronous throw becomes a rejection.
    const current = new Promise<void>((resolve) => resolve(run()));
    state.running = current;
    const settle = () => {
      state.running = null;
      const waiting = state.rerun;
      if (waiting) {
        // Hand-over in the same tick: no window in which a new caller could
        // see the queue idle and start a second run beside the rerun.
        state.rerun = null;
        waiting.settleWith(start(state));
      }
    };
    current.then(settle, settle);
    return current;
  };

  return () => {
    const state = getState();
    if (!state.running) return start(state);
    if (!state.rerun) {
      let settleWith!: (run: Promise<void>) => void;
      const promise = new Promise<void>((resolve) => {
        settleWith = resolve;
      });
      state.rerun = { promise, settleWith };
    }
    return state.rerun.promise;
  };
}
