import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// Connect to the address an SSRF guard classified, not to whatever the name
// resolves to a moment later.
//
// Every guard here resolves a host, classifies the answers and then hands the
// HOSTNAME to a client that resolves it again. A resolver the admin's name
// points at can answer a public address for the check and 127.0.0.1 for the
// connect (DNS rebinding), or fail the first lookup — which the guards treated
// as "allow" — and answer a private address for the second. Pinning the
// connection to the checked address leaves one resolution, and its answer is
// the one that was classified.
//
// The web-side twin of `buildPinnedAgent` in pinchy-web/web-fetch.ts. Not
// imported from there: a plugin directory is mounted standalone and owns its
// own `undici`, so the two copies share the idea, not the module.
//
// Pinned to undici 7, because of how it treats Node's global dispatcher slot.
// Node 22 bundles undici 6, which keeps the dispatcher Node's `fetch` uses in
// the `undici.globalDispatcher.1` slot (NODE_USE_ENV_PROXY installs its proxy
// agent there before any user code runs). undici 7 reads that slot and only
// fills it when it is empty; it never overwrites one that is set. undici 8
// reads `.2` only, so it installs its own dispatcher into `.1` on load and
// replaces Node's — for the whole process, since this module loads at boot.
// An operator's egress proxy would vanish from every plain fetch in Pinchy.
// pinned-connection-global-dispatcher.test.ts holds that line.
//
// What this does NOT reach: the connections that matter most at runtime are
// made from the OpenClaw container — inference against a custom provider's
// base URL (OpenClaw), Odoo JSON-RPC and IMAP/SMTP (pinchy-odoo, pinchy-email).
// Those resolve the stored name themselves, so a rebinding resolver still has
// its window there. Pinchy can only pin the probes it makes itself.

/** An IP address an SSRF guard has classified, with its family. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * `ip` as a {@link PinnedAddress}. Accepts a bracketed IPv6 literal, as
 * `URL.hostname` returns it. Throws on anything that is not an address: a
 * name here would quietly turn the pin back into a lookup.
 */
export function toPinnedAddress(ip: string): PinnedAddress {
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const family = isIP(bare);
  if (family === 0) throw new Error("A pinned address must be an IP literal.");
  return { address: bare, family: family === 6 ? 6 : 4 };
}

/**
 * Every address a guard classified for one host, in the resolver's order —
 * never empty. The whole set is pinned, not only the first: each one was
 * checked, so handing all of them to the connector costs no safety and keeps
 * its fallback (Happy Eyeballs, or the next record when one is down).
 */
export type PinnedTarget = readonly [PinnedAddress, ...PinnedAddress[]];

/** `ips` as a {@link PinnedTarget}. Throws on an empty list or a non-address. */
export function toPinnedTarget(ips: readonly string[]): PinnedTarget {
  if (ips.length === 0) throw new Error("A pinned target needs at least one address.");
  const [first, ...rest] = ips.map(toPinnedAddress);
  return [first, ...rest];
}

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: Error | null,
  address: string | LookupAddress[],
  family?: number
) => void;
type LookupFunction = (
  hostname: string,
  options: { all?: boolean },
  callback: LookupCallback
) => void;

/**
 * A `dns.lookup`-shaped function that answers every name with `target`.
 *
 * Honours both halves of the contract: with `all: true` (how undici's
 * connector and Node's address fallback ask) it answers every pinned address
 * as an array; answering that in the flat form leaves the caller reading
 * `undefined` as the address (ERR_INVALID_IP_ADDRESS, surfaced only as
 * "fetch failed"). The flat form gets the first.
 */
export function pinnedLookup(target: PinnedTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(
        null,
        target.map(({ address, family }) => ({ address, family }))
      );
    } else {
      callback(null, target[0].address, target[0].family);
    }
  };
}

/**
 * `fetch(url, init)`, connecting to `target`'s checked addresses instead of
 * resolving the URL's host. The URL is otherwise untouched, so the Host header, TLS SNI and
 * certificate verification still use the name.
 *
 * MUST use the npm `undici`'s fetch together with its `Agent`: Node's global
 * fetch is backed by Node's bundled undici, whose request handlers reject the
 * npm package's Agent (UND_ERR_INVALID_ARG, reported only as "fetch failed").
 *
 * Never follows a redirect: a followed hop is a connection nobody checked,
 * and to an address literal it needs no lookup, so the pin would not even
 * apply. A redirect comes back as the 3xx it is (`redirect: "manual"` is the
 * default here, whatever fetch's own default is); a caller that wants to
 * follow it checks and pins the next hop itself. Asking for `"follow"` throws.
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit,
  target: PinnedTarget
): Promise<Response> {
  const agent = createPinnedAgent(target);
  try {
    return await fetchWithPinnedAgent(url, init, agent);
  } finally {
    // Graceful: an Agent's close waits for the request in flight — body
    // included — and only then drops the socket, so the caller can still read
    // the response it gets back.
    agent.close().catch(() => {});
  }
}

/**
 * An undici Agent whose connections go to `target`'s checked addresses. For a
 * caller that makes many requests to one checked host and wants the sockets
 * kept alive between them: build one, pass it to {@link fetchWithPinnedAgent},
 * close it when done.
 */
export function createPinnedAgent(target: PinnedTarget): Agent {
  return new Agent({ connect: { lookup: pinnedLookup(target) } });
}

/** {@link pinnedFetch}'s request, on an agent from {@link createPinnedAgent}. */
export async function fetchWithPinnedAgent(
  url: string,
  init: RequestInit,
  agent: Agent
): Promise<Response> {
  if (init.redirect === "follow") {
    throw new TypeError(
      'pinnedFetch never follows a redirect; pass redirect: "manual" and check the next hop.'
    );
  }
  return (await undiciFetch(url, {
    ...(init as Record<string, unknown>),
    redirect: init.redirect ?? "manual",
    dispatcher: agent,
  })) as unknown as Response;
}
