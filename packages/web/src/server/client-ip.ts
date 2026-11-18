/**
 * Which address a request actually came from — read once, for everything that
 * needs it.
 *
 * Pinchy binds `127.0.0.1:7777` and expects an operator-supplied reverse proxy
 * in front, so `socket.remoteAddress` is the proxy in every real deployment
 * and `X-Forwarded-For` is the only place the client's address exists. Three
 * separate call sites were reading one or the other, and all three were wrong
 * in a different way (#825):
 *
 * - The **sign-in throttle** let better-auth read `X-Forwarded-For` with no
 *   `trustedProxies` configured. That trusts a single-value header blindly —
 *   rotate the header, get a fresh 5-per-60s bucket, and the brute-force limit
 *   is gone — while a proxy that *appends* (nginx's `$proxy_add_x_forwarded_for`
 *   default) produces two values, which better-auth refuses to read at all, so
 *   every sign-in on the instance collapses into one shared bucket and five
 *   failures lock the login endpoint for everyone.
 * - The **WebSocket upgrade limiter** keyed on `socket.remoteAddress`, i.e. on
 *   the proxy — one global 60-upgrades-per-minute bucket for all users.
 * - The **`auth.csrf_blocked` / `auth.host_blocked` audit rows** recorded the
 *   same peer address. All nine rows ever written on the production instance
 *   say `::ffff:172.18.0.1`, the Docker bridge gateway: a row whose "who"
 *   field is a constant, and nothing about it looks broken while it is.
 *
 * The resolution itself is better-auth's own `getIPFromHeader`, imported rather
 * than reimplemented. The throttle keys its buckets with that function; if this
 * module computed the address a second way the two would eventually disagree
 * about who a request is, which is the failure `matchesRequestHost` was
 * extracted to prevent on the host side.
 */

import {
  findInvalidTrustedProxies,
  getIPFromHeader,
  normalizeIP,
} from "@better-auth/core/utils/ip";
import type { IncomingHttpHeaders } from "http";

/**
 * Internal header `server.ts` stamps with the resolved address, and the only
 * header better-auth is configured to read.
 *
 * It exists because better-auth resolves the address from headers alone and
 * has no way to see the socket — so a deployment with no proxy at all (nothing
 * sets `X-Forwarded-For`) resolves to nothing and lands back in the single
 * shared bucket. Stamping the answer we already have removes that hole.
 *
 * `server.ts` overwrites it on every request. A client-supplied copy would be
 * a total bypass, since a header named in `ipAddressHeaders` is trusted as-is.
 */
export const CLIENT_IP_HEADER = "x-pinchy-client-ip";

/**
 * Loopback only — deliberately NOT the RFC 1918 ranges.
 *
 * The list answers one question: which hops in `X-Forwarded-For` are OUR
 * infrastructure and must be walked past. With a single appending proxy the
 * header holds exactly one entry, the client's own, so any non-empty list is
 * enough to switch better-auth from "trust one value blindly" to "take the
 * rightmost hop the sender could not choose" — which is the fix.
 *
 * Adding the private ranges would look more thorough and would be a bypass: on
 * a company LAN the client's real address IS `192.168.x.x`, trusting that range
 * strips it, and the resolver then hands back the attacker's forged hop to its
 * left. Operators with a second inner proxy (or Cloudflare in front) name their
 * own ranges in `PINCHY_TRUSTED_PROXIES`.
 */
export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1/128"];

export const TRUSTED_PROXIES_ENV_VAR = "PINCHY_TRUSTED_PROXIES";

export type ClientIpSource = "forwarded" | "socket" | "unknown";

export type ResolvedClientIp = {
  /** The client's address, or `null` when neither source yielded one. */
  address: string | null;
  /**
   * Where the address came from. `socket` means it is the peer we are talking
   * to — behind a proxy that is the proxy, not the client — so an audit row
   * carrying it says "this is as far as I can see", instead of quietly passing
   * a constant off as the origin of the request.
   */
  source: ClientIpSource;
};

/**
 * Splits `PINCHY_TRUSTED_PROXIES` into usable entries and typo'd ones.
 *
 * better-auth drops an unparseable entry with a warning and carries on, which
 * means a typo reads exactly like a configured trust list. Returning the
 * rejects separately is what lets startup say which entry it ignored.
 */
export function parseTrustedProxies(raw: string | undefined): {
  trusted: string[];
  invalid: string[];
} {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) return { trusted: DEFAULT_TRUSTED_PROXIES, invalid: [] };

  // Validated by better-auth's own parser, so an entry this module accepts is
  // exactly an entry the throttle will honour.
  const invalid = findInvalidTrustedProxies(entries);
  const trusted = entries.filter((entry) => !invalid.includes(entry));

  // An all-typo list must not degrade to "trust nothing" — that is the
  // single-value rule this module exists to leave behind, reached by accident.
  return { trusted: trusted.length > 0 ? trusted : DEFAULT_TRUSTED_PROXIES, invalid };
}

export function getTrustedProxies(): { trusted: string[]; invalid: string[] } {
  return parseTrustedProxies(process.env[TRUSTED_PROXIES_ENV_VAR]);
}

/**
 * The `X-Forwarded-For` value as one string.
 *
 * Node joins repeated headers itself, but not for every code path that can
 * produce them; joining an array rather than taking the first occurrence
 * matters because the right-to-left walk lands on the LAST hop, and dropping
 * later occurrences would delete exactly the entry we are looking for.
 */
export function readForwardedFor(headers: IncomingHttpHeaders): string | undefined {
  const value = headers["x-forwarded-for"];
  if (Array.isArray(value)) return value.join(", ");
  return value;
}

/**
 * The client's address, preferring what the proxy forwarded and falling back
 * to the peer we can see.
 *
 * The fallback fires both when nothing forwarded a header (no proxy at all)
 * and when the header resolved to nothing (every hop trusted, or a value that
 * is not an address). In the latter cases the peer is genuinely all that is
 * knowable, and `source: "socket"` says so.
 */
export function resolveClientIp(input: {
  forwardedFor: string | undefined;
  socketAddress: string | undefined;
  trustedProxies: string[];
}): ResolvedClientIp {
  if (input.forwardedFor) {
    const forwarded = getIPFromHeader(input.forwardedFor, {
      trustedProxies: input.trustedProxies,
    });
    if (forwarded) return { address: forwarded, source: "forwarded" };
  }

  if (input.socketAddress) {
    // `::ffff:172.18.0.1` and `172.18.0.1` are the same host; normalizing here
    // keeps one client out of two rate-limit buckets depending on whether the
    // connection arrived over a dual-stack listener.
    return { address: normalizeIP(input.socketAddress), source: "socket" };
  }

  return { address: null, source: "unknown" };
}

/**
 * The two audit-detail keys that say who a blocked request came from.
 *
 * `remoteAddress` stays what it always was — the peer, i.e. the proxy — because
 * every row already written means that and rewriting the meaning of a key would
 * silently reinterpret history. `clientAddress` is the new answer to "who", and
 * `clientAddressSource` is what keeps it honest: `socket` marks a row where the
 * two fields are the same address because nothing forwarded a better one, so an
 * analyst can tell "this is the client" from "this is as far as we can see".
 */
export function clientAddressDetail(client: ResolvedClientIp): {
  clientAddress: string | null;
  clientAddressSource: ClientIpSource;
} {
  return { clientAddress: client.address, clientAddressSource: client.source };
}

/**
 * Resolves the address and writes it into `CLIENT_IP_HEADER`, replacing
 * whatever the client sent under that name.
 *
 * Deleting first is not an optimization: an unresolvable request must leave no
 * header at all, or a client that sends one keeps it and better-auth reads an
 * attacker-chosen bucket key.
 */
export function stampClientIp(
  headers: IncomingHttpHeaders,
  options: { trustedProxies: string[]; socketAddress: string | undefined }
): ResolvedClientIp {
  const forwardedFor = readForwardedFor(headers);
  delete headers[CLIENT_IP_HEADER];

  const resolved = resolveClientIp({
    forwardedFor,
    socketAddress: options.socketAddress,
    trustedProxies: options.trustedProxies,
  });

  if (resolved.address) headers[CLIENT_IP_HEADER] = resolved.address;
  return resolved;
}
