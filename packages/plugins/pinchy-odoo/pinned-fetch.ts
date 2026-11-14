import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, fetch as undiciFetch } from "undici";
import { pinnedLookup, type PinnedTarget } from "./pinned-target.js";

// odoo-node (0.3.x) calls the global `fetch` by URL and takes neither a fetch
// function nor a dispatcher, so the plugin cannot hand it the addresses
// Pinchy checked (pinned-target.ts). This is the seam: inside
// `withPinnedFetch` a request to the checked origin goes through undici with a
// lookup hook that answers the checked addresses; every other request, and
// every request outside the scope, is the ordinary global fetch. Same shape as
// the web app's `odoo-pin.ts`.
//
// The pin travels in AsyncLocalStorage, so two agents on two Odoo connections
// cannot see each other's pin, and nothing is left behind once the call
// settles. The global is wrapped once and re-checked on each entry: OpenClaw
// shares one process (and one `globalThis.fetch`) with every plugin, and a
// later replacement is wrapped again rather than silently undoing the pin.
//
// The store lives on `globalThis` next to the wrapper, for the same reason:
// OpenClaw restarts its gateway inside the process and evaluates this module
// again. The new copy finds the old wrapper installed and keeps it, so it has
// to pin into the store that wrapper reads — a module-local store would leave
// every Odoo call unpinned, and without its timeout, until the process ends.
//
// MUST use the npm `undici`'s fetch together with its `Agent`: Node's global
// fetch is backed by Node's bundled undici, which rejects the npm package's
// Agent (UND_ERR_INVALID_ARG, reported only as "fetch failed"). Pinned to
// undici 7 for the global-dispatcher reason pinchy-web's web-fetch.ts gives.

type Pin = {
  origin: string;
  /**
   * The scope's connector, created when the scope opens and closed when it
   * settles. `pinOdooClient` opens one scope per odoo-node call.
   */
  dispatcher: Agent;
  timeoutMs: number;
};

const STORE = Symbol.for("pinchy.odoo.pinStore");

function store(): AsyncLocalStorage<Pin> {
  const holder = globalThis as unknown as { [STORE]?: AsyncLocalStorage<Pin> };
  return (holder[STORE] ??= new AsyncLocalStorage<Pin>());
}

// odoo-node passes no signal, so before the pin an Odoo that accepted the
// connection and never answered held the agent's tool call open for good.
// Well above a legitimate worst case (a large search_read, a reconcile) — the
// bound is there to end a blackhole, not to budget latency.
const ODOO_REQUEST_TIMEOUT_MS = 120_000;

const WRAPPER = Symbol.for("pinchy.odoo.pinnedFetch");
type Fetch = typeof globalThis.fetch;

function requestUrl(input: Parameters<Fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * `fetch` through the scope's pinned connector instead of resolving the URL's
 * host. The URL is otherwise untouched, so the Host header, TLS SNI and
 * certificate verification still use the name.
 *
 * Never follows a redirect, whatever the caller asked: a followed hop is a
 * connection nobody checked. odoo-node already asks for "manual".
 */
async function pinnedFetch(
  url: string,
  init: RequestInit | undefined,
  pin: Pin
): Promise<Response> {
  const timeout = AbortSignal.timeout(pin.timeoutMs);
  return (await undiciFetch(url, {
    ...((init ?? {}) as Record<string, unknown>),
    redirect: "manual",
    // The caller's own signal, if it passed one, still cancels.
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    dispatcher: pin.dispatcher,
  })) as unknown as Response;
}

function ensureInstalled(): void {
  const current = globalThis.fetch as Fetch & { [WRAPPER]?: true };
  if (current[WRAPPER]) return;

  const wrapper = ((input: Parameters<Fetch>[0], init?: RequestInit) => {
    const pin = store().getStore();
    if (pin) {
      const url = requestUrl(input);
      if (new URL(url).origin === pin.origin) {
        // A Request carries its method, headers and body inside it, and the
        // pinned path forwards only `init`. odoo-node calls by URL; anything
        // else is refused rather than sent as a different request.
        if (typeof input !== "string" && !(input instanceof URL)) {
          return Promise.reject(
            new TypeError(
              "pinchy-odoo: a pinned Odoo request must be made by URL, not as a Request"
            )
          );
        }
        return pinnedFetch(url, init, pin);
      }
    }
    return current(input, init);
  }) as Fetch & { [WRAPPER]?: true };
  wrapper[WRAPPER] = true;
  globalThis.fetch = wrapper;
}

/** Runs `fn` with every request to `url`'s origin pinned to `target`. */
export async function withPinnedFetch<T>(
  url: string,
  target: PinnedTarget,
  fn: () => Promise<T>,
  { timeoutMs = ODOO_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<T> {
  ensureInstalled();
  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup(target) as never, autoSelectFamily: true },
  });
  try {
    return await store().run({ origin: new URL(url).origin, dispatcher, timeoutMs }, fn);
  } finally {
    // Graceful: a response body the caller has not read yet still arrives.
    dispatcher.close().catch(() => {});
  }
}

/**
 * `client`, with every method call pinned to `target` — the addresses Pinchy
 * checked for the connection's `url`. A Proxy rather than a list of wrapped
 * methods, so a method odoo-node adds later is pinned too instead of quietly
 * resolving the name again.
 */
export function pinOdooClient<C extends object>(client: C, url: string, target: PinnedTarget): C {
  return new Proxy(client, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        withPinnedFetch(url, target, async () => value.apply(obj, args));
    },
  });
}
