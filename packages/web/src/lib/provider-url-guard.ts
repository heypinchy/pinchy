// SSRF guard for admin-supplied OpenAI-compatible provider base URLs (#894).
//
// Unlike the five built-in providers (fixed public hosts), a custom provider's
// base URL is user input, and Pinchy fetches it server-side at discover/validate
// time. Pinchy also runs in two topologies: self-hosted-by-the-customer (where
// the admin owns the whole box) AND hosted-by-us (Fleet / trial control-plane,
// where the tenant admin does NOT own the infrastructure). So the guard must
// protect the hosted case without breaking the self-hosted one.
//
// Posture (security-professional take: minimal customer friction, maximum
// protection of the one thing that actually matters):
//   - ALWAYS hard-block the ranges that are never a legitimate model endpoint and
//     ARE the classic SSRF prize: link-local 169.254.0.0/16 + fe80::/10 (cloud
//     metadata / IMDS credential theft), loopback, unspecified, multicast,
//     reserved, and the IPv4-mapped-IPv6 forms of all of them. Blocking these
//     costs a real deployment nothing — nobody runs an LLM on 169.254.169.254.
//   - Private LANs (RFC1918 / ULA) are ALLOWED BY DEFAULT so self-hosted
//     vLLM/TGI/LiteLLM on the local network works out of the box, but a hosted
//     deployment can lock them down with PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS=1.
//   - Non-http(s) schemes (file://, gopher://, …) are rejected — z.string().url()
//     alone lets file:///etc/passwd through.
//   - The HOSTNAME IS RESOLVED and every resolved IP is classified, so a name
//     that points at 169.254.169.254 can't sneak past a literal-string check.
//
// The runtime chat traffic is fetched by OpenClaw (which ships its own SSRF
// guard); this module covers Pinchy's own discover/validate probes and the
// persisted value at save time.

import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";

export type ProviderUrlBlockReason = "unsupported_scheme" | "blocked_address" | "private_address";

export class ProviderUrlBlockedError extends Error {
  constructor(
    public readonly reason: ProviderUrlBlockReason,
    message: string
  ) {
    super(message);
    this.name = "ProviderUrlBlockedError";
  }
}

/** How an IP is treated: routable public, private LAN (env-gated), or always-blocked. */
export type IpCategory = "public" | "private" | "blocked";

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

function classifyIpv4(a: number, b: number, _c: number, _d: number): IpCategory {
  // Always-blocked — never a legitimate model endpoint.
  if (a === 0) return "blocked"; // 0.0.0.0/8 unspecified / "this host"
  if (a === 127) return "blocked"; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return "blocked"; // 169.254.0.0/16 link-local (incl. 169.254.169.254 IMDS)
  if (a >= 224) return "blocked"; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  // Private / carrier-shared — allowed unless the deployment opts out.
  if (a === 10) return "private"; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 CGNAT
  return "public";
}

/** Expand any IPv6 form (incl. `::` compression and embedded IPv4) to 8 hextets. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%"); // strip zone id (fe80::1%eth0)
  if (pct !== -1) s = s.slice(0, pct);

  // Embedded IPv4 in the final group (e.g. ::ffff:1.2.3.4) → fold into two hextets.
  const lastColon = s.lastIndexOf(":");
  const lastGroup = s.slice(lastColon + 1);
  if (lastGroup.includes(".")) {
    const v4 = parseIpv4(lastGroup);
    if (!v4) return null;
    const h1 = (v4[0] << 8) | v4[1];
    const h2 = (v4[2] << 8) | v4[3];
    s = s.slice(0, lastColon + 1) + h1.toString(16) + ":" + h2.toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

  let groups: string[];
  if (tail === null) {
    groups = head;
    if (groups.length !== 8) return null;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }

  const hextets = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (hextets.length !== 8 || hextets.some((h) => Number.isNaN(h))) return null;
  return hextets;
}

function classifyIpv6(ip: string): IpCategory {
  const h = expandIpv6(ip);
  if (!h) return "blocked"; // isIP said v6 but we can't parse it — refuse rather than wave through

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): classify the
  // embedded v4 so a mapped 169.254.169.254 is caught like its bare form.
  const headAllZero = h.slice(0, 5).every((x) => x === 0);
  if (headAllZero && (h[5] === 0xffff || h[5] === 0)) {
    if (h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return "blocked"; // :: and ::1
    return classifyIpv4(h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff);
  }

  if (h.every((x) => x === 0)) return "blocked"; // :: unspecified
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return "blocked"; // ::1 loopback
  if ((h[0] & 0xffc0) === 0xfe80) return "blocked"; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return "blocked"; // ff00::/8 multicast
  if ((h[0] & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique-local (ULA)
  return "public";
}

/** Classify a literal IPv4/IPv6 address. Non-IP input is treated as blocked. */
export function classifyIp(ip: string): IpCategory {
  const version = isIP(ip);
  if (version === 4) {
    const q = parseIpv4(ip);
    return q ? classifyIpv4(q[0], q[1], q[2], q[3]) : "blocked";
  }
  if (version === 6) return classifyIpv6(ip);
  return "blocked";
}

/** True when the deployment has opted to also block private/LAN addresses. */
export function isPrivateNetworkBlockEnabled(): boolean {
  const v = process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS;
  return v === "1" || v?.toLowerCase() === "true";
}

/** Resolve a hostname to all of its A/AAAA addresses. Injected in tests. */
export type HostResolver = (host: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (host) => {
  const res = await dnsLookup(host, { all: true });
  return res.map((r) => r.address);
};

/**
 * Throw {@link ProviderUrlBlockedError} if `rawUrl` is not a safe target for a
 * server-side provider fetch. See the module header for the full posture.
 *
 * Fail-open on DNS resolution failure: a host that doesn't resolve can't be
 * classified, and blocking it would reject providers that are merely
 * temporarily unreachable — the subsequent fetch fails naturally instead.
 */
export async function assertAllowedProviderUrl(
  rawUrl: string,
  resolver: HostResolver = defaultResolver
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderUrlBlockedError("unsupported_scheme", "The base URL is not a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderUrlBlockedError("unsupported_scheme", "Only http(s) base URLs are allowed.");
  }

  let addresses: string[];
  try {
    addresses = await resolver(url.hostname);
  } catch {
    return; // unresolvable — fail open (see doc-comment)
  }

  const blockPrivate = isPrivateNetworkBlockEnabled();
  for (const addr of addresses) {
    const category = classifyIp(addr);
    if (category === "blocked") {
      throw new ProviderUrlBlockedError(
        "blocked_address",
        "That host resolves to a reserved or internal address that isn't allowed."
      );
    }
    if (category === "private" && blockPrivate) {
      throw new ProviderUrlBlockedError(
        "private_address",
        "That host resolves to a private network address, which is disabled on this deployment."
      );
    }
  }
}
