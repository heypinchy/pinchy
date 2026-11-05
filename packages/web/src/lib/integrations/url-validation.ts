/**
 * SSRF protection: validates that user-supplied URLs don't target
 * private/internal networks (AWS metadata, localhost, RFC-1918, etc.).
 */

import { lookup as dnsLookup } from "node:dns/promises";
// The address table is shared with `web_fetch`, and its canonical copy lives in
// the pinchy-web plugin (a plugin can import nothing outside itself; web can).
// Two lists would drift -- they did: neither knew 100.64.0.0/10. Import-free by
// design; see ip-address.ts.
import { classifyIpAddress, type IpAddressClass } from "../../../../plugins/pinchy-web/ip-address";

import { toPinnedTarget, type PinnedTarget } from "@/lib/pinned-connection";

export { classifyIpAddress, type IpAddressClass };

const PRIVATE_HOSTNAMES = new Set(["localhost", "localhost.", "ip6-localhost", "ip6-loopback"]);

/**
 * Returns true if the given URL string targets a private/internal address.
 * Note: This checks the hostname string only, not DNS resolution. A hostname
 * that resolves to a private IP (DNS rebinding) would pass this check —
 * `validateExternalUrl` below closes that gap for its own callers by also
 * resolving a DNS name and classifying every returned address. A caller that
 * uses `isPrivateUrl` directly gets the string-only check and nothing more:
 * today that is `imap-autodiscover.ts`, which compensates by rejecting every
 * address literal outright and only ever fetching over HTTPS. A name with an
 * internal A record is still not covered there — narrower than it sounds
 * (HTTPS only, and the host is derived from the user's own email domain), but
 * not closed.
 */
export function isPrivateUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false; // Can't determine — let validateExternalUrl handle parse errors
  }

  const hostClass = classifyHostname(url.hostname);
  return hostClass !== null && hostClass !== "public";
}

/**
 * Classifies a URL's host from the string alone: the address class for an IP
 * literal, and null for a genuine DNS name — which no amount of string
 * inspection can answer for, only a resolver can.
 *
 * Both string-only callers go through here so they cannot drift: `isPrivateUrl`
 * collapses the answer to a boolean, and `validateExternalUrl` keeps the class
 * so it can phrase the right refusal and decide whether DNS is still needed.
 */
function classifyHostname(hostname: string): IpAddressClass | null {
  // A well-known private name is loopback wherever it resolves at all; naming
  // the class rather than returning a bare `true` is what lets the caller say
  // "never a real server" instead of suggesting an opt-out that doesn't apply.
  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) return "loopback";

  // `URL.hostname` keeps the brackets around an IPv6 literal ("[::1]"), which
  // `classifyIpAddress` strips — and which `dns.lookup` chokes on, so this is
  // also the step that keeps a literal away from the resolver. Exactly that
  // step was missing in `provider-url-guard.ts`, whose fail-open catch then
  // waved every IPv6 literal through.
  return classifyIpAddress(hostname);
}

type ValidationResult = { valid: true; url: string } | { valid: false; error: string };

/** Resolves a hostname to all of its A/AAAA addresses. Injected in tests. */
export type UrlHostResolver = (host: string) => Promise<string[]>;

const defaultUrlHostResolver: UrlHostResolver = async (host) => {
  const results = await dnsLookup(host, { all: true });
  return results.map((result) => result.address);
};

// Two messages, because the two cases deserve different advice. Loopback,
// link-local (cloud metadata), the unspecified address and the reserved
// special-purpose ranges (multicast, TEST-NETs, 240/4, ...) are never a real
// Odoo server, so there is nothing to trade off and nothing to suggest. An
// RFC-1918 / ULA / CGNAT (Tailscale) / 198.18/15 address, on the other hand, is exactly where an on-premise
// Odoo legitimately lives — so that one names the way to allow it. Same split
// as `mail-host-guard.ts`; both strings keep the word "private" so a caller
// asserting on it stays honest.
const INTERNAL_NETWORK_ERROR =
  "Blocked: this URL targets a loopback, link-local, cloud-metadata or otherwise reserved " +
  "address, which is never a private Odoo server.";

const PRIVATE_NETWORK_ERROR =
  "Blocked: this URL targets a private network address. " +
  "Set ALLOW_PRIVATE_URLS=1 to allow an Odoo server on your own network.";

/** The message to answer with for the address class that caused the block. */
function blockMessageFor(addressClass: IpAddressClass): string {
  return addressClass === "private" ? PRIVATE_NETWORK_ERROR : INTERNAL_NETWORK_ERROR;
}

/**
 * Validates a user-supplied URL for server-side requests.
 * Returns the normalized origin or an error message.
 *
 * Two tiers, the same as `mail-host-guard.ts`:
 *
 *   - Always refused: loopback, unspecified, link-local (cloud metadata,
 *     including 100.100.100.200, Azure's WireServer 168.63.129.16 and the
 *     EC2/EKS/GCP/OCI addresses inside ULA), and the reserved
 *     special-purpose ranges. No Odoo server lives there.
 *   - Refused unless `ALLOW_PRIVATE_URLS=1`: the `private` class — RFC-1918,
 *     ULA, CGNAT (Tailscale), 198.18/15. That is where an on-premise Odoo lives, and also
 *     where the odoo-e2e and eval stacks reach odoo-mock on the Docker network.
 *
 * The flag opens that one class and nothing else. It used to switch the whole
 * check off, which turned "my Odoo is on the tailnet" into "an Odoo admin can
 * reach 127.0.0.1 and the metadata services". Loopback and metadata are now
 * closed whatever is set. The services on the compose network are not: with
 * the flag set, `http://openclaw:18789` and `http://db:5432` resolve to bridge
 * addresses, which are `private` like any LAN host, so they are as reachable
 * as the on-premise Odoo the flag is for. With the flag set, a DNS name is
 * still resolved and classified.
 *
 * A hostname that is an IP literal, or one of the well-known private names
 * (`localhost`, …), is classified from the string alone via `classifyHostname`
 * — no DNS involved, and no literal is ever handed to the resolver. A hostname
 * that is a genuine DNS name is additionally RESOLVED and every returned
 * address is classified, so a name that points at 169.254.169.254 (cloud
 * metadata) or an RFC-1918 address can't sneak past a check that only ever
 * read the hostname string.
 *
 * What this does NOT cover is rebinding between this lookup and the request
 * that follows: the address is classified here, and whoever connects next
 * resolves the name again. A caller that makes the request itself uses
 * {@link resolveExternalUrlTarget} and pins it. Callers that hand the URL to
 * odoo-node cannot: odoo-node calls the global `fetch` and takes no
 * dispatcher, so `test-credentials`, `sync-preview`, the schema sync and the
 * create/update checks keep the window. So does pinchy-odoo, which resolves
 * the stored URL inside the OpenClaw container for every tool call.
 *
 * Fails open on DNS resolution failure: a name that doesn't resolve can't be
 * classified, and the far more likely cause is a typo — blocking it here
 * would misreport a config mistake as a security error, and the subsequent
 * fetch fails naturally anyway.
 */
export async function validateExternalUrl(
  urlString: string,
  resolver: UrlHostResolver = defaultUrlHostResolver
): Promise<ValidationResult> {
  const checked = await checkExternalUrl(urlString, resolver);
  if (!checked.valid) return checked;
  return { valid: true, url: checked.url };
}

const UNRESOLVABLE_ERROR = "Could not resolve the server's host name. Check the URL for a typo.";

/**
 * {@link validateExternalUrl} for a caller that makes the request itself: the
 * verdict plus the addresses it classified, so the request can be pinned to
 * them (`pinnedFetch`) instead of resolving the name a second time.
 *
 * Does NOT fail open. With one lookup there is no later fetch to "fail
 * naturally" — a name with no answer is refused here, with a message that
 * says so rather than one about private networks. Every address is returned,
 * since every one was checked — the connector can still fall back between
 * them.
 */
export async function resolveExternalUrlTarget(
  urlString: string,
  resolver: UrlHostResolver = defaultUrlHostResolver
): Promise<{ valid: true; url: string; target: PinnedTarget } | { valid: false; error: string }> {
  const checked = await checkExternalUrl(urlString, resolver);
  if (!checked.valid) return checked;
  if (checked.addresses.length === 0) return { valid: false, error: UNRESOLVABLE_ERROR };
  return { valid: true, url: checked.url, target: toPinnedTarget(checked.addresses) };
}

/**
 * The shared check: a refusal, or the origin plus every address it reaches —
 * the literal itself, the resolver's answers, or none when the name did not
 * resolve (which each caller treats its own way).
 */
async function checkExternalUrl(
  urlString: string,
  resolver: UrlHostResolver
): Promise<{ valid: true; url: string; addresses: string[] } | { valid: false; error: string }> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: "Invalid URL" };
  }

  // Only allow HTTP and HTTPS
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      valid: false,
      error: "Only HTTP and HTTPS URLs are allowed",
    };
  }

  const allowPrivate = process.env.ALLOW_PRIVATE_URLS === "1";
  /** The refusal for this address class, or null when it may be reached. */
  const refusalFor = (addressClass: IpAddressClass | null): string | null => {
    if (addressClass === null || addressClass === "public") return null;
    if (addressClass === "private" && allowPrivate) return null;
    return blockMessageFor(addressClass);
  };

  const hostname = url.hostname;
  let addresses: string[];
  // Address literal or well-known private name: decided from the string
  // alone, no DNS involved.
  const hostClass = classifyHostname(hostname);
  if (hostClass !== null) {
    const refusal = refusalFor(hostClass);
    if (refusal !== null) return { valid: false, error: refusal };
    // A literal is already fully classified — DNS has nothing to add. (Every
    // well-known name is loopback and refused above, so this is a literal.)
    addresses = [hostname];
  } else {
    // A genuine DNS name. The address it points at is what actually gets
    // connected to, so resolve it and classify every answer: a name aimed at
    // 169.254.169.254 (cloud metadata) or an RFC-1918 address must not walk
    // past a check that only ever read the hostname string.
    try {
      addresses = await resolver(hostname);
    } catch {
      addresses = []; // unresolvable name — each caller decides, see above
    }
    for (const address of addresses) {
      const refusal = refusalFor(classifyIpAddress(address));
      if (refusal !== null) return { valid: false, error: refusal };
    }
  }

  // Return normalized origin (scheme + host + port, no path/query)
  return { valid: true, url: url.origin, addresses };
}
