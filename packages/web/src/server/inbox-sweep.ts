/**
 * The Inbox Agent reconciliation-sweep scheduler (Brick E): the in-process
 * cadence that drives {@link import("@/lib/email-workflows/sweep").runReconciliationSweep}
 * autonomously, mirroring the established periodic-job pattern (`upload-gc.ts`,
 * `audit-verify-job.ts`) — a `setInterval` plus a post-startup kick.
 *
 * The sweep is BOTH the correctness path and the low-latency path. It re-lists a
 * whole window every cadence, but the sweep's ledger pre-filter and
 * watermark-bounded window make a steady-state pass cost one `search` and ~zero
 * reads (the expensive N+1 `read` runs only for genuinely new mail). That is what
 * lets it run on a short cadence and react in near-real-time itself — no separate
 * token-free poll (the abandoned OpenClaw event-trigger brick) is needed, and it
 * is still the backstop that guarantees no email is ever lost.
 */

/**
 * Wrap a sweep in a re-entrancy guard: a call made while a previous run is still
 * in flight is *skipped*, never run concurrently.
 *
 * The ledger's atomic claim already makes overlapping sweeps *correct* (no email
 * is claimed twice), but not *free* — each pass re-lists the whole window and
 * hits provider rate limits. Without this guard a sweep slower than the cadence
 * would stack redundant provider I/O on top of itself. In-flight state is
 * encapsulated per runner (rather than a module-level flag) so it is directly
 * testable and cannot leak between callers.
 */
export function createGuardedSweepRunner(runSweep: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runSweep();
    } catch (err) {
      // A sweep failure is logged and swallowed, never rethrown: the interval
      // fires this as `void run()`, so a rejection would be an unhandled
      // process-level rejection. The `finally` still frees the guard, so one bad
      // pass never wedges every future sweep.
      console.error("[inbox-sweep] sweep failed:", err);
    } finally {
      inFlight = false;
    }
  };
}

/**
 * Cadence for the reconciliation sweep. Short on purpose: this IS the low-latency
 * path. A steady-state pass costs one `search` per connection and hydrates only
 * genuinely-new mail (the sweep's ledger pre-filter + watermark-bounded window),
 * so a frequent cadence is affordable — one minute trades a little provider I/O
 * for near-real-time reaction. Tunable via `INBOX_SWEEP_INTERVAL_MS` for large
 * deployments where per-connection poll volume matters more than latency.
 */
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * Delay before the first pass, so the OpenClaw gateway and config have settled
 * after a restart before we dispatch (mirrors upload-gc/audit-verify-job).
 */
export const SWEEP_STARTUP_DELAY_MS = 30_000;

let _interval: ReturnType<typeof setInterval> | null = null;
let _startupTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Start the in-process sweep cadence: a post-startup kick plus a recurring
 * interval, both firing the same re-entrancy-guarded runner so a slow pass never
 * overlaps its own next tick. `runSweep` is injected (production composes it in
 * `inbox-sweep-deps.ts`), keeping the scheduler decoupled from DB and gateway —
 * which is what lets these tests run with no mocks at all.
 *
 * `opts` overrides the cadence. Production leaves it empty; the E2E stack shortens
 * it via `INBOX_SWEEP_INTERVAL_MS`, since no test can wait 15 minutes for a tick.
 *
 * Idempotent: the timer handles live in module state, so a second start without
 * this would overwrite the first one's handles and orphan an interval that fires
 * forever with nobody holding a reference to stop it — doubling every sweep's
 * provider I/O. That leak is the reason this cadence is not hung off the
 * gateway's `connected` event; making start itself safe removes the footgun
 * instead of leaving it for every future caller to remember.
 */
export function startInboxSweep(
  runSweep: () => Promise<void>,
  opts: { intervalMs?: number; startupDelayMs?: number } = {}
): void {
  stopInboxSweep();
  const guarded = createGuardedSweepRunner(runSweep);
  _interval = setInterval(() => void guarded(), opts.intervalMs ?? SWEEP_INTERVAL_MS);
  _startupTimeout = setTimeout(() => {
    _startupTimeout = null;
    void guarded();
  }, opts.startupDelayMs ?? SWEEP_STARTUP_DELAY_MS);
}

/** Stop the cadence, clearing both timers so a stopped scheduler never fires again. */
export function stopInboxSweep(): void {
  if (_interval !== null) {
    clearInterval(_interval);
    _interval = null;
  }
  if (_startupTimeout !== null) {
    clearTimeout(_startupTimeout);
    _startupTimeout = null;
  }
}

/** Test-only helper (mirrors upload-gc / audit-verify-job pattern). */
export function _isInboxSweepRunning(): boolean {
  return _interval !== null;
}
