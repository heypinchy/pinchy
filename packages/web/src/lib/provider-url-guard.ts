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
//     ARE the classic SSRF prize: link-local 169.254.0.0/16 + fe80::/10 and the
//     metadata services that sit inside private ranges (100.100.100.200,
//     and the EC2/EKS/GCP/OCI addresses inside ULA) — IMDS credential theft — plus loopback, unspecified,
//     multicast, the reserved/documentation ranges, and every IPv6 form that
//     carries an IPv4 address (mapped, NAT64, 6to4, Teredo, SIIT). Blocking
//     these costs a real deployment nothing — nobody runs an LLM on
//     169.254.169.254.
//   - Loopback stays blocked even though "Ollama on localhost" sounds like a
//     use case: inside the Pinchy container 127.0.0.1 is Pinchy itself, never
//     the host. A model server on the host is reached by a LAN address or a
//     `host-gateway` alias, which Docker on Linux and Docker Desktop answer
//     with a private address (OrbStack answers 0.250.250.254, inside 0.0.0.0/8,
//     which was blocked before the shared table too).
//   - Private LANs (RFC1918 / ULA / CGNAT, i.e. Tailscale / 198.18/15) are ALLOWED BY
//     DEFAULT so self-hosted vLLM/TGI/LiteLLM on the local network works out of
//     the box, but a hosted deployment can lock them down with
//     PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS=1.
//
// Which address is which comes from the table every SSRF guard in Pinchy
// shares (`pinchy-web/ip-address.ts`, via `url-validation.ts`). This module
// only maps its classes onto the three verdicts above; it kept a list of its
// own once, and that list missed the metadata address inside CGNAT and every
// translated IPv6 form.
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
import { classifyIpAddress } from "@/lib/integrations/url-validation";

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

/**
 * Classify a literal IPv4/IPv6 address. Non-IP input is treated as blocked.
 *
 * A thin mapping over the shared table: `public` and `private` keep their
 * meaning, and every other class — loopback, unspecified, link-local
 * (metadata), reserved — is never a model endpoint.
 */
export function classifyIp(ip: string): IpCategory {
  const addressClass = classifyIpAddress(ip);
  if (addressClass === "public" || addressClass === "private") return addressClass;
  return "blocked";
}

/** True when the deployment has opted to also block private/LAN addresses. */
export function isPrivateNetworkBlockEnabled(): boolean {
  const v = process.env.PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS;
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * The URL's host as a bare address literal, or null when it is a name.
 *
 * `URL.hostname` keeps the brackets on an IPv6 host: `new URL("http://[::1]/")
 * .hostname` is `"[::1]"`, not `"::1"`. That string satisfies neither
 * `isIP()` nor `dns.lookup()`, so before this existed every IPv6 literal fell
 * straight through the resolver's fail-open catch and IPv6 classification was
 * unreachable from URL input. `lib/integrations/url-validation.ts` has always
 * de-bracketed; this guard was written later and lost the step.
 */
function hostnameAsIpLiteral(hostname: string): string | null {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    // Bracketed means IPv6 literal (RFC 3986). No zone-id handling needed:
    // the WHATWG parser rejects `http://[fe80::1%eth0]/` as an invalid URL
    // before this is reached. It DOES normalize the embedded-IPv4 form, so
    // `::ffff:169.254.169.254` arrives as `::ffff:a9fe:a9fe` — which the
    // shared table folds back to the same v4 classification.
    const inner = hostname.slice(1, -1);
    return isIP(inner) === 6 ? inner : null;
  }
  return isIP(hostname) !== 0 ? hostname : null;
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

  // An address literal is already the answer — classify it and never involve
  // DNS. Resolving it is what lost the IPv6 case: `dns.lookup("[::1]")`
  // throws, and the fail-open below then waved it through.
  const literal = hostnameAsIpLiteral(url.hostname);
  if (literal !== null) {
    assertAddressesAllowed([literal]);
    return;
  }
  if (url.hostname.startsWith("[")) {
    // Bracketed but not a parseable IPv6 address, so it is not a name either.
    // Refuse rather than hand it to a resolver whose failure means "allow".
    throw new ProviderUrlBlockedError(
      "blocked_address",
      "That host is not a valid address or hostname."
    );
  }

  let addresses: string[];
  try {
    addresses = await resolver(url.hostname);
  } catch {
    return; // unresolvable NAME — fail open (see doc-comment)
  }

  assertAddressesAllowed(addresses);
}

/** Throw if any address in the set is one this deployment refuses to reach. */
function assertAddressesAllowed(addresses: string[]): void {
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
