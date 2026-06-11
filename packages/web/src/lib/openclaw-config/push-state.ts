// Pending-state tracker for `pushConfigInBackground` coroutines.
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
// (which also triggers regenerates) can load SEPARATE instances of this
// module, so a plain module-level counter would give the route a counter the
// server's pushes never touch.

interface ConfigPushState {
  pending: number;
}

declare global {
  var __pinchyConfigPushState: ConfigPushState | undefined;
}

function state(): ConfigPushState {
  globalThis.__pinchyConfigPushState ??= { pending: 0 };
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

/** Test-only: reset between tests. Do not call in app code. */
export function _resetConfigPushState(): void {
  state().pending = 0;
}
