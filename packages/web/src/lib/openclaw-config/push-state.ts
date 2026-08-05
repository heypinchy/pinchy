// Process-wide state for `pushConfigInBackground` coroutines: how many are in
// flight, and which generation is the newest. Both must be shared by every
// module instance in the process, which is what puts them on globalThis (see
// the note at the bottom of this comment).
//
// Why: config pushes are fire-and-forget, and under OC 5.3's `config.apply`
// rate-limit (~3 calls / 45 s) a push coroutine can be PARKED for 33–53 s
// waiting out the advertised window. During that gap the config change — e.g.
// a freshly-granted `plugins.entries.pinchy-email.config.agents.<id>` block —
// is not yet in OC's runtime, but nothing observable said so: OC stays
// connected, `/api/health/openclaw` reports `connected: true`, the E2E
// stability gates pass, and the suite dispatches a chat whose run snapshots
// its tool list WITHOUT the pending change. The agent then answers
// "I can't use the tool email_list … it isn't available" (the email/odoo/web/
// telegram dispatch-probe flake class, sibling of heypinchy/pinchy#464).
//
// This tracker makes "a config push is still in flight" observable.
// `/api/health/openclaw` reports it as `configPushesPending`, and the E2E
// stability gates require it to be 0 before declaring OC stable.
//
// globalThis-backed for the same reason as `server/openclaw-client.ts`:
// Next.js API routes (which serve the health endpoint) and the custom server
// (which also triggers regenerates) load SEPARATE instances of this module, so
// a plain module-level counter would give the route a counter the server's
// pushes never touch.
//
// Measured, not assumed — a module-load probe in `write.ts` on the dev stack
// printed two instance ids under ONE pid: the first at server boot (custom
// server, `node --import tsx server.ts`), the second on the first request to an
// API route that imports it (Next's route registry). Same process, same
// globalThis, two module instances. That is why `generation` lives here too:
// with a module-level counter each instance mints 1, 2, 3… in private, so a
// route push cannot supersede a server push and both reach `config.apply` —
// the restart storm the generation guard exists to stop (#193).

interface ConfigPushState {
  pending: number;
  generation: number;
}

declare global {
  var __pinchyConfigPushState: ConfigPushState | undefined;
}

function state(): ConfigPushState {
  globalThis.__pinchyConfigPushState ??= { pending: 0, generation: 0 };
  return globalThis.__pinchyConfigPushState;
}

/** Record that a `pushConfigInBackground` coroutine has started. */
export function trackConfigPushStarted(): void {
  state().pending++;
}

/**
 * Record that a push coroutine reached a terminal state — applied via WS,
 * superseded by a newer push, or file-write fallback. Floors at zero so a
 * spurious double-settle can never wedge the counter negative.
 */
export function trackConfigPushSettled(): void {
  const s = state();
  s.pending = Math.max(0, s.pending - 1);
}

/** Number of push coroutines currently in flight (0 = config is settled). */
export function getPendingConfigPushCount(): number {
  return state().pending;
}

/**
 * Claim the next push generation. `pushConfigInBackground` stamps every
 * coroutine with one and abandons itself as soon as a newer one exists, so a
 * stale payload can never land on top of a newer one (#193).
 *
 * It lives here, next to the pending counter, for the same globalThis reason:
 * the custom server and Next's route bundles each hold their OWN instance of
 * `write.ts` (measured — one pid, two module-load probes), so a plain
 * module-level counter would let each mint generations 1, 2, 3… in private.
 * A route-triggered push then cannot supersede a server-triggered one: both
 * reach `config.apply`, which is the restart storm the counter exists to stop.
 */
export function nextConfigPushGeneration(): number {
  return ++state().generation;
}

/** The newest generation any module instance in this process has claimed. */
export function getCurrentConfigPushGeneration(): number {
  return state().generation;
}

/** Test-only: reset the pending counter between tests. Do not call in app code. */
export function _resetConfigPushState(): void {
  state().pending = 0;
}

// There is deliberately NO reset for `generation`. It is a cancellation token
// whose only guarantee is monotonicity — a number minted once must never be
// minted again, or a coroutine parked at gen 1 compares equal to a later
// push's gen 1 and sails through the supersede check (see
// `_supersedePendingPushes` in write.ts, and the flake it was written for).
// Now that the counter is process-wide, a reset would recycle tokens held by
// the other module instance's coroutines as well. Tests that need a known
// starting value seed the globalThis object directly, which is what a
// contract test for this cell should be doing anyway.
