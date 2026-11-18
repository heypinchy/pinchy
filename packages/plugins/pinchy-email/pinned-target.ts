/**
 * Connect to the addresses Pinchy checked, not to whatever the stored name
 * resolves to a moment later.
 *
 * Pinchy re-checks a connection's stored destination (the Odoo URL, the IMAP
 * and SMTP hosts) every time a plugin fetches its credentials, against the
 * same SSRF rules an admin's save went through. It used to hand back only the
 * NAME, and the plugin's client library resolved it again. A resolver the
 * name points at can answer a public address to Pinchy's check and
 * 127.0.0.1, the metadata service or an internal host to the plugin's
 * connect (DNS rebinding). So the credentials route now also answers the
 * addresses it classified (`checkedAddresses`, keyed by credential field),
 * and the plugin connects to those through a lookup hook. One resolution, and
 * its answer is the one that was checked.
 *
 * The whole checked set is pinned, not only the first address: every one was
 * classified, so handing all of them to the connector costs no safety and
 * keeps its fallback (Happy Eyeballs, or the next record when one is down).
 * Only the socket's destination changes — the name stays the host the client
 * is given, so TLS SNI, certificate verification and the HTTP Host header
 * still use it.
 *
 * DUPLICATED ON PURPOSE, byte-for-byte, into pinchy-email. A plugin directory
 * is mounted standalone and can import nothing outside itself;
 * `packages/web/src/__tests__/lib/plugin-pinned-target-drift.test.ts` holds
 * the copies together. Edit this (pinchy-odoo) copy and copy it over. The web
 * app's twin is `packages/web/src/lib/pinned-connection.ts`.
 */
import { isIP } from "node:net";

/** An IP address Pinchy's SSRF guard classified, with its family. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address Pinchy checked for one destination, in its order — never empty. */
export type PinnedTarget = readonly [PinnedAddress, ...PinnedAddress[]];

/**
 * The addresses Pinchy checked for credential `field`, from a credentials-API
 * answer, or undefined when it checked none (the name did not resolve on
 * Pinchy's side, or the field has no destination).
 *
 * A malformed answer throws rather than reading as "nothing checked": the
 * caller treats undefined as "refuse to connect", and a parse that quietly
 * degraded to it would hide a contract break behind a misleading error.
 */
export function checkedTarget(
  data: Record<string, unknown>,
  field: string
): PinnedTarget | undefined {
  const all = data.checkedAddresses;
  if (all === undefined) return undefined;
  if (typeof all !== "object" || all === null || Array.isArray(all)) {
    throw new Error("The credentials API answered malformed checkedAddresses.");
  }
  const addresses = (all as Record<string, unknown>)[field];
  if (addresses === undefined) return undefined;
  if (!Array.isArray(addresses)) {
    throw new Error(`The credentials API answered malformed checkedAddresses.${field}.`);
  }
  if (addresses.length === 0) return undefined;

  const pinned = addresses.map((address): PinnedAddress => {
    const family = typeof address === "string" ? isIP(address) : 0;
    if (family === 0) {
      throw new Error(
        `The credentials API answered something other than a checked address for ${field}.`
      );
    }
    return { address: address as string, family: family === 6 ? 6 : 4 };
  });
  return pinned as unknown as PinnedTarget;
}

type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;
type LookupOptions = { all?: boolean; family?: number | string };

/**
 * A `dns.lookup`-shaped function that answers every name with `target`.
 *
 * Honours both halves of the contract: with `all: true` — how Node's
 * connection fallback (`autoSelectFamily`) and undici's connector ask — it
 * answers every pinned address as an array; the flat form gets the first.
 * A `family` filter is honoured, and a filter that leaves nothing fails the
 * way a resolver with no answer does.
 */
export function pinnedLookup(target: PinnedTarget) {
  return (_hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family =
      options?.family === 4 || options?.family === "IPv4"
        ? 4
        : options?.family === 6 || options?.family === "IPv6"
          ? 6
          : 0;
    const matching = target.filter((entry) => family === 0 || entry.family === family);
    if (matching.length === 0) {
      const err: NodeJS.ErrnoException = new Error(
        `getaddrinfo ENOTFOUND ${_hostname} (no checked IPv${family} address)`
      );
      err.code = "ENOTFOUND";
      process.nextTick(() => callback(err, ""));
      return;
    }
    process.nextTick(() => {
      if (options?.all) {
        callback(
          null,
          matching.map(({ address, family }) => ({ address, family }))
        );
      } else {
        callback(null, matching[0].address, matching[0].family);
      }
    });
  };
}
