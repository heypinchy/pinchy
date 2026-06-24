/**
 * Wrap a function so it runs at most once; later calls are no-ops.
 *
 * Used for cleanup that can be triggered from more than one event for the same
 * resource — e.g. a WebSocket emits both `error` and `close` on an abrupt
 * disconnect, and a non-idempotent release (a counter decrement) must run only
 * once per socket.
 */
export function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}
