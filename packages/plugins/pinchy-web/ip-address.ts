/**
 * The one table that decides whether an IP address is somewhere an outbound
 * request may go — shared, verbatim, by the two SSRF guards in Pinchy.
 *
 * ── Why this file exists, and why it lives HERE ───────────────────────────
 * `web_fetch` (this plugin, OpenClaw container) fetches a URL a model chose,
 * and the web app's `url-validation.ts` / `mail-host-guard.ts` check an
 * address an admin typed. Both ask the same question — "is this internal?" —
 * and for a long time each answered from its own list. The lists drifted:
 * neither knew 100.64.0.0/10 (CGNAT: Alibaba Cloud metadata at
 * 100.100.100.200, every Tailscale node), `web_fetch` matched `fe80:` as a
 * literal hextet, and neither unwrapped NAT64. A security list that exists
 * twice is wrong in one of the two places.
 *
 * So it is single-sourced. It lives in the PLUGIN because a plugin is deployed
 * as a self-contained directory and can import nothing outside itself; web is
 * unconstrained and reaches across with a relative path — the same move
 * `pinchy-files/pdf-scan-rule.ts` and `plugin-manifest-loader.ts` make.
 *
 * That is also why this module has NO imports and must keep none: web pulls it
 * into `next build`, so every dependency added here becomes a web dependency.
 * `escapingImportTargets` in `scripts/lib/prepush-build-gate.mjs` and the
 * `COPY` in `Dockerfile.pinchy` keep the classification honest.
 */

/**
 * What an IP address can reach. Split finer than "private or not" because
 * callers weigh the categories differently:
 *
 *   - `loopback`, `unspecified`, `link-local` (cloud metadata lives there),
 *     `reserved`: never a real server. No caller may opt into these.
 *   - `private`: RFC-1918, ULA and CGNAT (Tailscale). An on-premise Odoo or
 *     mail server legitimately lives here, so the admin-facing guards let an
 *     operator opt in; `web_fetch` blocks it unconditionally.
 *   - `public`: everything else.
 */
export type IpAddressClass =
  "loopback" | "unspecified" | "link-local" | "private" | "reserved" | "public";

/**
 * Parses a dotted-quad IPv4 literal into its four octets, or null if the
 * string isn't one. Deliberately strict — decimal digits only — so legacy
 * encodings ("0x7f.0.0.1", "2130706433") are NOT silently accepted as IPv4
 * here. `URL` rewrites those forms to dotted-quad before any caller gets here.
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
  const [a, b, c, d] = octets;

  // 0.0.0.0/8 — "this network"; 0.0.0.0 itself routes to the local host
  if (a === 0) return "unspecified";
  // 127.0.0.0/8 — loopback
  if (a === 127) return "loopback";
  // 169.254.0.0/16 — link-local (cloud metadata lives at 169.254.169.254)
  if (a === 169 && b === 254) return "link-local";
  // 100.100.100.200 — Alibaba Cloud's instance-metadata endpoint. It sits in
  // CGNAT below, which an operator may opt into for a tailnet; this one
  // address must stay unreachable when they do.
  if (a === 100 && b === 100 && c === 100 && d === 200) return "link-local";
  // 10.0.0.0/8 — class A private
  if (a === 10) return "private";
  // 172.16.0.0/12 — class B private
  if (a === 172 && b >= 16 && b <= 31) return "private";
  // 192.168.0.0/16 — class C private
  if (a === 192 && b === 168) return "private";
  // 100.64.0.0/10 — carrier-grade NAT (RFC 6598). Tailscale hands every node a
  // 100.x address, so a self-hosted Odoo over a tailnet lives here.
  if (a === 100 && (b & 0xc0) === 64) return "private";

  // Special-purpose blocks that are not routable on the public internet. A
  // request aimed at one is steering at an internal path, never at a server.
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return "reserved";
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — documentation (TEST-NET-1/2/3)
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b & 0xfe) === 18) return "reserved";
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved (includes 255.255.255.255)
  if (a >= 224) return "reserved";

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

  const embeddedV4 = (high: number, low: number) =>
    classifyIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);

  // Every form that carries an IPv4 address: classify the address it names, not
  // the IPv6 wrapper — `URL` hands these over as e.g. "[::ffff:7f00:1]", which
  // reads as an ordinary public IPv6 address.
  //   ::ffff:a.b.c.d  IPv4-mapped (::ffff:0:0/96)
  //   ::a.b.c.d       IPv4-compatible (deprecated; nothing public lives in ::/96)
  //   64:ff9b::a.b.c.d NAT64 (RFC 6052): a translator forwards it to that IPv4
  const upperZero = groups.slice(0, 5).every((group) => group === 0);
  if (upperZero && (groups[5] === 0xffff || groups[5] === 0)) {
    return embeddedV4(groups[6], groups[7]);
  }
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return embeddedV4(groups[6], groups[7]);
  }
  // 6to4 (2002::/16) carries the IPv4 in the two groups after the prefix.
  if (groups[0] === 0x2002) return embeddedV4(groups[1], groups[2]);

  // 64:ff9b:1::/48 — local-use NAT64 (RFC 8215). Operator-defined translation,
  // so the embedded address cannot be read off; never a public destination.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return "reserved";
  // fc00::/7 — unique local addresses
  if ((groups[0] & 0xfe00) === 0xfc00) return "private";
  // fe80::/10 — link-local (spans fe80 through febf)
  if ((groups[0] & 0xffc0) === 0xfe80) return "link-local";
  // fec0::/10 — deprecated site-local (RFC 3879). Withdrawn, but still routed
  // inside many networks, so treat it like ULA rather than as public.
  if ((groups[0] & 0xffc0) === 0xfec0) return "private";
  // ff00::/8 — multicast
  if ((groups[0] & 0xff00) === 0xff00) return "reserved";
  // 2001:db8::/32 — documentation
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return "reserved";

  return "public";
}
