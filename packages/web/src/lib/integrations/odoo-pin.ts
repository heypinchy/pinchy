import { AsyncLocalStorage } from "node:async_hooks";
import {
  createPinnedAgent,
  fetchWithPinnedAgent,
  type PinnedTarget,
} from "@/lib/pinned-connection";

// odoo-node (0.3.x) calls the global `fetch` by hostname and takes neither a
// fetch function nor a dispatcher, so a route that checked an Odoo URL cannot
// hand the checked address to it. This is the seam: inside `withPinnedOdooFetch`
// a request to the checked origin goes through one pinned connector to the
// addresses the guard classified, and a request to ANY other origin is refused
// — a stray request inside the scope would otherwise go out by name, which is
// the hole this closes. Outside a scope the global fetch is untouched.
//
// The pin travels in AsyncLocalStorage, so two admins testing two Odoo servers
// at once cannot see each other's pin, and nothing is left behind once the
// callback settles. The store lives on `globalThis`: a bundler that loads this
// module twice would otherwise give each copy its own store, and the wrapper
// installed by one would read an empty one from the other. The global fetch is
// wrapped once and the wrapper is re-checked on each entry, so a later
// replacement of `globalThis.fetch` (a test stub, a polyfill) is wrapped again
// rather than silently undone.

type Pin = {
  origin: string;
  /** One connector per scope: a schema sync makes hundreds of requests. */
  agent: ReturnType<typeof createPinnedAgent>;
};

const STORE = Symbol.for("pinchy.odooPinStore");
const WRAPPER = Symbol.for("pinchy.odooPinnedFetch");

type Fetch = typeof globalThis.fetch;
type Wrapped = Fetch & { [WRAPPER]?: true };

function store(): AsyncLocalStorage<Pin> {
  const holder = globalThis as unknown as { [STORE]?: AsyncLocalStorage<Pin> };
  return (holder[STORE] ??= new AsyncLocalStorage<Pin>());
}

/** The URL and init a pinned request carries, whatever shape fetch was called with. */
async function describeRequest(
  input: Parameters<Fetch>[0],
  init: RequestInit | undefined
): Promise<{ url: string; init: RequestInit }> {
  if (typeof input === "string") return { url: input, init: init ?? {} };
  if (input instanceof URL) return { url: input.href, init: init ?? {} };
  const request = input as Request;
  return {
    url: request.url,
    init: {
      method: request.method,
      headers: request.headers,
      body: request.body ? await request.arrayBuffer() : undefined,
      signal: request.signal,
      ...init,
    },
  };
}

function ensureInstalled(): void {
  const current = globalThis.fetch as Wrapped;
  if (current[WRAPPER]) return;

  const wrapper: Wrapped = async (input, init) => {
    const pin = store().getStore();
    if (!pin) return current(input, init);

    const request = await describeRequest(input, init);
    if (new URL(request.url).origin !== pin.origin) {
      throw new TypeError(
        `Refused a request to ${new URL(request.url).origin} inside a scope pinned to ` +
          `${pin.origin}: it would be sent by host name, unchecked.`
      );
    }
    return fetchWithPinnedAgent(request.url, request.init, pin.agent);
  };
  wrapper[WRAPPER] = true;
  globalThis.fetch = wrapper;
}

/**
 * Runs `fn` with every request to `origin` pinned to `target` — the addresses
 * `resolveExternalUrlTarget` classified for that origin.
 */
export async function withPinnedOdooFetch<T>(
  origin: string,
  target: PinnedTarget,
  fn: () => Promise<T>
): Promise<T> {
  ensureInstalled();
  const agent = createPinnedAgent(target);
  try {
    return await store().run({ origin, agent }, fn);
  } finally {
    // Graceful: waits for any request still in flight.
    agent.close().catch(() => {});
  }
}

/** Is the caller already inside a scope pinned to `origin`? */
export function isPinnedTo(origin: string): boolean {
  return store().getStore()?.origin === origin;
}
