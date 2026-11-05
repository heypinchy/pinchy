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
// Pinned to undici 7, the major Node 22 bundles. undici 8 installs its own
// global dispatcher when it loads (it reads a global slot Node 22 never sets)
// and so replaces the one Node's `fetch` uses — for the whole process, since
// this module loads at boot. An operator's NODE_USE_ENV_PROXY egress proxy
// would vanish from every plain fetch in Pinchy.
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
 * Honours both halves of the contract: undici's connector asks with
 * `all: true` and reads an array; answering it in the flat form leaves it
 * reading `undefined` as the address (ERR_INVALID_IP_ADDRESS, surfaced only as
 * "fetch failed").
 */
export function pinnedLookup(target: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

/**
 * `fetch(url, init)`, connecting to `target` instead of resolving the URL's
 * host. The URL is otherwise untouched, so the Host header, TLS SNI and
 * certificate verification still use the name.
 *
 * MUST use the npm `undici`'s fetch together with its `Agent`: Node's global
 * fetch is backed by Node's bundled undici, whose request handlers reject the
 * npm package's Agent (UND_ERR_INVALID_ARG, reported only as "fetch failed").
 *
 * Follows no redirect on its own behalf — a caller that wants to follow one
 * passes `redirect: "manual"` and pins the next hop itself.
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit,
  target: PinnedAddress
): Promise<Response> {
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(target) } });
  try {
    return (await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher,
    })) as unknown as Response;
  } finally {
    // Graceful: an Agent's close waits for the request in flight — body
    // included — and only then drops the socket, so the caller can still read
    // the response it gets back.
    dispatcher.close().catch(() => {});
  }
}
