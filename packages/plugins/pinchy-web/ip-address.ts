/**
 * The one table that decides whether an IP address is somewhere an outbound
 * request may go — shared, verbatim, by every SSRF guard in Pinchy.
 *
 * ── Why this file exists, and why it lives HERE ───────────────────────────
 * `web_fetch` (this plugin, OpenClaw container) fetches a URL a model chose,
 * and the web app's `url-validation.ts` (Odoo), `mail-host-guard.ts` (IMAP/
 * SMTP) and `provider-url-guard.ts` (OpenAI-compatible base URLs) check an
 * address an admin typed. All ask the same question — "is this internal?" —
 * and for a long time each answered from its own list. The lists drifted:
 * none knew Alibaba Cloud's metadata at 100.100.100.200 (inside CGNAT, where
 * every Tailscale node lives), `web_fetch` matched `fe80:` as a literal
 * hextet, and none unwrapped NAT64. A security list that exists twice is
 * wrong in one of the two places.
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
 *   - `loopback`, `unspecified`, `link-local` (cloud metadata lives there,
 *     including the metadata addresses that sit inside private ranges and
 *     Azure's WireServer at 168.63.129.16, which sits in public space),
 *     `reserved`: never a real server. Every guard refuses these whatever the
 *     operator sets.
 *   - `private`: RFC-1918, ULA, CGNAT (Tailscale), 198.18/15 and local-use NAT64
 *     (64:ff9b:1::/48). An on-premise Odoo, mail server or model endpoint
 *     legitimately lives here, so the admin-facing
 *     guards let an operator opt in (Odoo: `ALLOW_PRIVATE_URLS`, mail:
 *     `ALLOW_PRIVATE_MAIL_HOSTS`) or allow it by default and let a hosted
 *     deployment opt out (OpenAI-compatible providers:
 *     `PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS`). `web_fetch` blocks it
 *     unconditionally.
 *   - `public`: everything else.
 *
 * Callers branch on the class, never re-derive it: an opt-in that opens more
 * than `private` is the bug this split exists to prevent.
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
  // CGNAT below, which an operator may open for a tailnet (`private` is the
  // class every opt-in unlocks); classifying it as link-local is what keeps
  // this one address unreachable when they do.
  if (a === 100 && b === 100 && c === 100 && d === 200) return "link-local";
  // 168.63.129.16 — Azure's WireServer / host agent. Public-looking and
  // Microsoft-owned, but reachable only from inside an Azure VM: it serves
  // DHCP, DNS, the load balancer's health probe and the VM extension
  // configuration, certificates included. A metadata endpoint in all but
  // name, so it gets the class no opt-in opens. Its neighbours are ordinary
  // public space.
  if (a === 168 && b === 63 && c === 129 && d === 16) return "link-local";
  // 10.0.0.0/8 — class A private
  if (a === 10) return "private";
  // 172.16.0.0/12 — class B private
  if (a === 172 && b >= 16 && b <= 31) return "private";
  // 192.168.0.0/16 — class C private
  if (a === 192 && b === 168) return "private";
  // 100.64.0.0/10 — carrier-grade NAT (RFC 6598). Tailscale hands every node a
  // 100.x address, so a self-hosted Odoo over a tailnet lives here.
  if (a === 100 && (b & 0xc0) === 64) return "private";
  // 198.18.0.0/15 — benchmarking (RFC 2544). Not publicly routed, but not
  // "never a server" either: operators number internal lab and transit
  // networks from it, and fake-IP DNS (Clash, Mihomo, Surge) answers every
  // name with an address from it — on such a host a perfectly ordinary Odoo
  // or mail server resolves here. It used to be `reserved`, which left those
  // installs no opt-in at all; it is private space in practice, so it gets the
  // private class and the opt-ins that come with it.
  if (a === 198 && (b & 0xfe) === 18) return "private";

  // Special-purpose blocks that are not routable on the public internet. A
  // request aimed at one is steering at an internal path, never at a server.
  // 192.0.0.0/24 — IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return "reserved";
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — documentation (TEST-NET-1/2/3)
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved (includes 255.255.255.255)
  if (a >= 224) return "reserved";

  return "public";
}

/**
 * Cloud metadata and credential endpoints that sit inside ULA (fc00::/7) — the
 * IPv6 twins of 169.254.169.254. ULA is `private`, the class an operator may
 * open, so each of these has to be named or opening the private network would
 * open them too. Same reasoning as 100.100.100.200 inside CGNAT above.
 *
 *   fd00:ec2::254       AWS EC2 instance metadata (IMDS) over IPv6
 *   fd00:ec2::23        AWS EKS Pod Identity Agent — hands a pod its IAM
 *                       credentials (IPv6 twin of 169.254.170.23)
 *   fd20:ce::254        Google Cloud metadata server (metadata.google.internal)
 *   fd00:c1::a9fe:a9fe  Oracle Cloud (OCI) instance metadata — 169.254.169.254
 *                       in the low 32 bits
 *
 * Exact addresses, not prefixes: the rest of each /64 is ordinary ULA as far as
 * any provider documents. Azure's IMDS has no IPv6 address. Written as strings
 * and parsed once, so every spelling of an address (expanded, upper case, a
 * dotted-quad tail) matches by value.
 */
const IPV6_METADATA_ADDRESSES: readonly number[][] = [
  "fd00:ec2::254",
  "fd00:ec2::23",
  "fd20:ce::254",
  "fd00:c1::a9fe:a9fe",
].map((address) => {
  const groups = parseIPv6(address);
  if (!groups) throw new Error(`ip-address.ts: unparseable metadata address ${address}`);
  return groups;
});

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
  // Cloud metadata inside ULA — named here, before ULA is matched below.
  if (
    IPV6_METADATA_ADDRESSES.some((metadata) =>
      metadata.every((group, index) => group === groups[index])
    )
  ) {
    return "link-local";
  }
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

  // Two more forms that carry an IPv4 address, refused outright rather than
  // decoded — neither is ever a server of its own, so failing closed costs
  // nothing:
  //   ::ffff:0:a.b.c.d  SIIT IPv4-translated (::ffff:0:0:0/96, RFC 2765); a
  //                     stateless translator forwards it to the embedded IPv4
  //   2001:0::/32       Teredo; the client's IPv4 is in the low groups, XORed
  // Only 2001:0000::/32 — 2001:4860:: (Google) and the rest of 2001::/16 are
  // ordinary public space.
  if (groups.slice(0, 4).every((group) => group === 0) && groups[4] === 0xffff && groups[5] === 0) {
    return "reserved";
  }
  if (groups[0] === 0x2001 && groups[1] === 0) return "reserved";

  // 64:ff9b:1::/48 — local-use NAT64 (RFC 8215): the prefix an operator's own
  // translator uses inside an IPv6-only network. The IPv4 mapping is
  // operator-defined, so the embedded address cannot be read off — but the
  // destination is that operator's network, which can legitimately host their
  // Odoo or mail server. So `private`: the admin opt-ins open it (knowing the
  // translator decides where it lands), web_fetch and the provider block-switch
  // refuse it like any other private address. Never globally routed, so never
  // `public`.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return "private";
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
