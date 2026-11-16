import {
  createPinnedAgent,
  fetchWithPinnedAgent,
  type PinnedTarget,
} from "@/lib/pinned-connection";
import { ODOO_REQUEST_TIMEOUT_MS } from "./odoo-timeout";

// A route that checked an Odoo URL hands odoo-node a fetch that connects to
// the checked addresses and nowhere else, instead of letting it fetch by name
// (a second lookup — DNS rebinding). `withPinnedOdoo` opens one pinned
// connector for the scope, gives `fn` the fetch bound to it, and closes the
// connector when `fn` settles. Nothing global is replaced: the pin travels
// with the fetch, so concurrent scopes cannot see each other's, and no other
// request in the process passes through it.

/** A fetch confined to one checked origin. Pass it to every OdooClient and `OdooClient.authenticate` in the scope. */
export type PinnedOdooFetch = typeof globalThis.fetch;

/**
 * Runs `fn` with a fetch whose requests to `origin` go to `target` — the
 * addresses `resolveExternalUrlTarget` classified for that origin. A request
 * to any other origin is refused: it would go out by name, unchecked.
 *
 * Each request gets its own bound of `timeoutMs` (see
 * {@link ODOO_REQUEST_TIMEOUT_MS}); a signal the caller passes still cancels.
 */
export async function withPinnedOdoo<T>(
  origin: string,
  target: PinnedTarget,
  fn: (pinned: PinnedOdooFetch) => Promise<T>,
  { timeoutMs = ODOO_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<T> {
  // One connector per scope: a schema sync makes hundreds of requests.
  const agent = createPinnedAgent(target);
  let open = true;

  const pinned: PinnedOdooFetch = async (input, init) => {
    if (!open) {
      throw new TypeError(`The scope pinned to ${origin} has ended; its connector is closed.`);
    }
    if (input instanceof Request) {
      throw new TypeError("A pinned Odoo fetch takes a URL, not a Request.");
    }
    const url = input instanceof URL ? input.href : input;
    const requested = new URL(url).origin;
    if (requested !== origin) {
      throw new TypeError(
        `Refused a request to ${requested} inside a scope pinned to ${origin}: ` +
          "it would be sent by host name, unchecked."
      );
    }
    // A fresh bound per request, not one deadline for the scope: a schema
    // sync makes hundreds. Combined with the caller's signal, never replaced
    // by it — `init.signal ?? timeout` would drop the bound for any caller
    // that passes a signal.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchWithPinnedAgent(url, { ...init, signal }, agent);
  };

  try {
    return await fn(pinned);
  } finally {
    open = false;
    // Graceful: waits for any request still in flight.
    agent.close().catch(() => {});
  }
}
