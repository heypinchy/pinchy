import { OdooClient, type OdooClientConfig } from "odoo-node";
import { Agent, fetch as undiciFetch } from "undici";
import { pinnedLookup, type PinnedTarget } from "./pinned-target.js";

// The Odoo connection goes to the addresses Pinchy checked (pinned-target.ts),
// never to whatever the name resolves to when the plugin connects. odoo-node
// takes a `fetch` per client, so the pin travels with the client: no other
// plugin in the OpenClaw process sees it, and nothing global is replaced.
//
// MUST use the npm `undici`'s fetch together with its `Agent`: Node's global
// fetch is backed by Node's bundled undici, which rejects the npm package's
// Agent (UND_ERR_INVALID_ARG, reported only as "fetch failed"). Pinned to
// undici 7 for the global-dispatcher reason pinchy-web's web-fetch.ts gives.

// Before the pin an Odoo that accepted the connection and never answered held
// the agent's tool call open for good. Well above a legitimate worst case (a
// large search_read, a reconcile) — the bound is there to end a blackhole, not
// to budget latency.
const ODOO_REQUEST_TIMEOUT_MS = 120_000;

type Fetch = typeof globalThis.fetch;

/**
 * A `fetch` that connects to `target` — the addresses Pinchy checked for
 * `url` — instead of resolving the URL's host. The URL is otherwise
 * untouched, so the Host header, TLS SNI and certificate verification still
 * use the name.
 *
 * Only requests to `url`'s origin, made by URL, are sent. A redirect is never
 * followed, whatever the caller asked: a followed hop is a connection nobody
 * checked. odoo-node already asks for "manual".
 */
export function pinnedOdooFetch(
  url: string,
  target: PinnedTarget,
  { timeoutMs = ODOO_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Fetch {
  const origin = new URL(url).origin;
  return async (input, init) => {
    // A Request carries its method, headers and body inside it, and this path
    // forwards only `init`. odoo-node calls by URL; anything else is refused
    // rather than sent as a different request.
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError(
        "pinchy-odoo: a pinned Odoo request must be made by URL, not as a Request"
      );
    }
    const href = typeof input === "string" ? input : input.href;
    const requested = new URL(href).origin;
    if (requested !== origin) {
      throw new TypeError(
        `pinchy-odoo: refused a request to ${requested}; this connection only reaches the address Pinchy checked for ${origin}`
      );
    }

    // One connector per request, closed gracefully once the response settles
    // (a body the caller has not read yet still arrives). Clients are cached
    // and dropped without a close hook, so a connector owned by the client
    // would leave its idle sockets to a keep-alive timer; this way nothing
    // stays open between calls. The price is a fresh handshake per RPC.
    const dispatcher = new Agent({
      connect: { lookup: pinnedLookup(target) as never, autoSelectFamily: true },
    });
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      return (await undiciFetch(href, {
        ...((init ?? {}) as Record<string, unknown>),
        redirect: "manual",
        // The caller's own signal, if it passed one, still cancels.
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        dispatcher,
      })) as unknown as Response;
    } finally {
      dispatcher.close().catch(() => {});
    }
  };
}

/** An OdooClient whose every request goes to `target`, the addresses Pinchy checked for `config.url`. */
export function pinOdooClient(config: OdooClientConfig, target: PinnedTarget): OdooClient {
  return new OdooClient({ ...config, fetch: pinnedOdooFetch(config.url, target) });
}
