import { AsyncLocalStorage } from "node:async_hooks";
import { pinnedFetch, type PinnedTarget } from "@/lib/pinned-connection";

// odoo-node (0.3.x) calls the global `fetch` by hostname and takes neither a
// fetch function nor a dispatcher, so a route that checked an Odoo URL cannot
// hand the checked address to it. This is the seam: inside `withPinnedOdooFetch`
// a request to the checked origin goes through `pinnedFetch` to the addresses
// the guard classified; every other request, and every request outside the
// scope, is the ordinary global fetch.
//
// The pin travels in AsyncLocalStorage, so two admins testing two Odoo servers
// at once cannot see each other's pin, and nothing is left behind once the
// callback settles. The global is wrapped once and the wrapper is re-checked on
// each entry, so a later replacement of `globalThis.fetch` (a test stub, a
// polyfill) is wrapped again rather than silently undone.

const store = new AsyncLocalStorage<{ origin: string; target: PinnedTarget }>();

const WRAPPER = Symbol.for("pinchy.odooPinnedFetch");
type Fetch = typeof globalThis.fetch;

function ensureInstalled(): void {
  const current = globalThis.fetch as Fetch & { [WRAPPER]?: true };
  if (current[WRAPPER]) return;

  const wrapper = ((input, init) => {
    const pin = store.getStore();
    if (pin) {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (new URL(url).origin === pin.origin) return pinnedFetch(url, init ?? {}, pin.target);
    }
    return current(input, init);
  }) as Fetch & { [WRAPPER]?: true };
  wrapper[WRAPPER] = true;
  globalThis.fetch = wrapper;
}

/**
 * Runs `fn` with every request to `origin` pinned to `target` — the addresses
 * `resolveExternalUrlTarget` classified for that origin.
 */
export function withPinnedOdooFetch<T>(
  origin: string,
  target: PinnedTarget,
  fn: () => Promise<T>
): Promise<T> {
  ensureInstalled();
  return store.run({ origin, target }, fn);
}
