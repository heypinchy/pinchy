/**
 * SSRF protection: validates that user-supplied URLs don't target
 * private/internal networks (AWS metadata, localhost, RFC-1918, etc.).
 */

const PRIVATE_HOSTNAMES = new Set(["localhost", "localhost.", "ip6-localhost", "ip6-loopback"]);

/**
 * What an IP address can reach. The categories are split finer than
 * "private or not" because callers weigh them differently: the mail-host
 * guard (see mail-host-guard.ts) blocks loopback/link-local/unspecified
 * unconditionally but lets an operator opt into `private`, since an
 * on-premise mail server legitimately lives on an RFC-1918 range.
 */
export type IpAddressClass = "loopback" | "unspecified" | "link-local" | "private" | "public";

/**
 * Parses a dotted-quad IPv4 literal into its four octets, or null if the
 * string isn't one. Deliberately strict — decimal digits only — so legacy
 * encodings ("0x7f.0.0.1", "2130706433") are NOT silently accepted as
 * IPv4 here. Both callers normalize before this point: `URL` rewrites those
 * forms to dotted-quad, and the mail-host guard classifies the addresses
 * getaddrinfo resolved rather than the raw input.
 */
function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

/**
 * Parses an IPv6 literal into its eight 16-bit groups, or null if the string
 * isn't one. Handles "::" compression, an embedded IPv4 tail
 * ("::ffff:127.0.0.1"), a zone identifier ("fe80::1%eth0") and surrounding
 * brackets.
 */
function parseIPv6(address: string): number[] | null {
  // Strip brackets and any zone id — neither changes which host is reached.
  const addr = address
    .replace(/^\[|\]$/g, "")
    .split("%")[0]
    .toLowerCase();
  if (!addr.includes(":")) return null;

  const [head, tail, ...extra] = addr.split("::");
  if (extra.length > 0) return null; // "::" may appear at most once

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    const parts = segment.split(":");
    for (const [index, part] of parts.entries()) {
      // An embedded IPv4 tail is only legal as the very last part.
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const octets = parseIPv4(part);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const headGroups = parseGroups(head);
  if (!headGroups) return null;

  if (tail === undefined) {
    return headGroups.length === 8 ? headGroups : null;
  }

  const tailGroups = parseGroups(tail);
  if (!tailGroups) return null;

  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 1) return null; // "::" must stand for at least one group
  return [...headGroups, ...Array(missing).fill(0), ...tailGroups];
}

function classifyIPv4(octets: number[]): IpAddressClass {
  const [a, b] = octets;

  // 0.0.0.0/8 — "this network"; 0.0.0.0 itself routes to the local host
  if (a === 0) return "unspecified";
  // 127.0.0.0/8 — loopback
  if (a === 127) return "loopback";
  // 169.254.0.0/16 — link-local (cloud metadata lives at 169.254.169.254)
  if (a === 169 && b === 254) return "link-local";
  // 10.0.0.0/8 — class A private
  if (a === 10) return "private";
  // 172.16.0.0/12 — class B private
  if (a === 172 && b >= 16 && b <= 31) return "private";
  // 192.168.0.0/16 — class C private
  if (a === 192 && b === 168) return "private";

  return "public";
}

/**
 * Rewrites an IP address literal into a single canonical spelling — dotted-quad
 * for IPv4, eight zero-padded hex groups for IPv6 — or returns null when the
 * string isn't an address. Lets callers compare against a specific address
 * ("fd00:ec2::254") without having to enumerate its spellings.
 */
export function canonicalizeIpAddress(address: string): string | null {
  const octets = parseIPv4(address);
  if (octets) return octets.join(".");

  const groups = parseIPv6(address);
  if (!groups) return null;

  return groups.map((group) => group.toString(16).padStart(4, "0")).join(":");
}

/**
 * Classifies an IP address literal, or returns null when the string isn't one
 * (a DNS name, a typo, an empty string). Callers that must decide about a
 * hostname have to resolve it first — this function never touches DNS.
 */
export function classifyIpAddress(address: string): IpAddressClass | null {
  const octets = parseIPv4(address);
  if (octets) return classifyIPv4(octets);

  const groups = parseIPv6(address);
  if (!groups) return null;

  if (groups.every((group) => group === 0)) return "unspecified";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";

  // Both forms that carry an IPv4 address in the low 32 bits: IPv4-mapped
  // (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d). Classify
  // the address they name rather than the wrapper — `URL` hands the latter over
  // as "[::7f00:1]", which reads as an ordinary public IPv6 address. Nothing
  // public lives in ::/96 either way, so decoding the tail can only be safer.
  const embedsIPv4 =
    groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0);
  if (embedsIPv4) {
    return classifyIPv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }

  // fc00::/7 — unique local addresses
  if ((groups[0] & 0xfe00) === 0xfc00) return "private";
  // fe80::/10 — link-local (spans fe80 through febf)
  if ((groups[0] & 0xffc0) === 0xfe80) return "link-local";

  return "public";
}

/**
 * Returns true if the given URL string targets a private/internal address.
 * Note: This checks the hostname string only, not DNS resolution. A hostname
 * that resolves to a private IP (DNS rebinding) would pass this check. For a
 * self-hosted product where admins control the network, this is acceptable.
 */
export function isPrivateUrl(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false; // Can't determine — let validateExternalUrl handle parse errors
  }

  const hostname = url.hostname;

  // Check well-known private hostnames
  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) return true;

  // Everything else is decided by the address ranges. A hostname that is not
  // an IP literal classifies as null and passes — see the DNS caveat above.
  // (`URL.hostname` keeps the brackets around an IPv6 literal; classifyIpAddress
  // strips them.)
  const addressClass = classifyIpAddress(hostname);
  return addressClass !== null && addressClass !== "public";
}

type ValidationResult = { valid: true; url: string } | { valid: false; error: string };

/**
 * Validates a user-supplied URL for server-side requests.
 * Returns the normalized origin or an error message.
 *
 * Set env var ALLOW_PRIVATE_URLS=1 to bypass private IP checks
 * (useful for Docker dev environments with internal service hostnames).
 */
export function validateExternalUrl(urlString: string): ValidationResult {
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

  // Check for private/internal addresses (unless bypassed)
  const allowPrivate = process.env.ALLOW_PRIVATE_URLS === "1";
  if (!allowPrivate && isPrivateUrl(urlString)) {
    return {
      valid: false,
      error: "URLs targeting private or internal networks are not allowed",
    };
  }

  // Return normalized origin (scheme + host + port, no path/query)
  return { valid: true, url: url.origin };
}
