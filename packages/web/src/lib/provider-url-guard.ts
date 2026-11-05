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
//     and the EC2/EKS/GCP/OCI addresses inside ULA) or in public space
//     (Azure's WireServer, 168.63.129.16) — IMDS credential theft — plus loopback, unspecified,
//     multicast, the reserved/documentation ranges, and the two IPv6 forms
//     that carry an IPv4 address without being a server of their own (Teredo,
//     SIIT). Blocking these costs a real deployment nothing — nobody runs an
//     LLM on 169.254.169.254.
//   - The other IPv6 forms that carry an IPv4 address (mapped, IPv4-compatible,
//     NAT64 64:ff9b::/96, 6to4) are not blocked as such: each is classified by
//     the IPv4 address it names, so ::ffff:169.254.169.254 is blocked like
//     169.254.169.254 and ::ffff:10.0.0.5 is private like 10.0.0.5. Local-use
//     NAT64 (64:ff9b:1::/48) is private: the operator's translator decides
//     where it lands.
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
// persisted value at save time. The probes connect to the address the guard
// classified (`resolveAllowedProviderTarget` + `pinnedFetch`), so a name that
// answers differently the second time is never asked a second time. OpenClaw
// resolves the stored base URL itself for every chat request, which Pinchy
// cannot pin: a rebinding resolver keeps its window there.

import { lookup as dnsLookup } from "dns/promises";
import { isIP } from "net";
import { classifyIpAddress } from "@/lib/integrations/url-validation";
import { toPinnedAddress, type PinnedAddress } from "@/lib/pinned-connection";

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

/**
 * How long the guard waits for a lookup before treating the name as
 * unresolvable. `dns.lookup` has no timeout of its own — it waits out the
 * system resolver's retries — and the guard sits in front of request paths:
 * the settings page's provider list, every config regenerate, every model
 * probe. A resolver that does not answer must not hold any of them.
 */
export const PROVIDER_DNS_LOOKUP_TIMEOUT_MS = 2_500;

/**
 * The guard's default resolver: every address `hostname` resolves to, or a
 * rejection once {@link PROVIDER_DNS_LOOKUP_TIMEOUT_MS} has passed. The guard
 * treats a timeout like any other resolution failure (fail open).
 */
export const resolveHostAddresses: HostResolver = (host) =>
  new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${PROVIDER_DNS_LOOKUP_TIMEOUT_MS} ms`)),
      PROVIDER_DNS_LOOKUP_TIMEOUT_MS
    );
    dnsLookup(host, { all: true }).then(
      (res) => {
        clearTimeout(timer);
        resolve(res.map((r) => r.address));
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

/**
 * A resolver that asks `resolver` once per host for as long as it lives —
 * failures included, so an unresolvable name costs one timeout, not one per
 * provider on it. Create one per regenerate or per request: a verdict is not
 * meant to outlive the work that asked for it.
 */
export function memoizeResolver(resolver: HostResolver = resolveHostAddresses): HostResolver {
  const answers = new Map<string, Promise<string[]>>();
  return (host) => {
    let answer = answers.get(host);
    if (!answer) {
      answer = resolver(host);
      answers.set(host, answer);
    }
    return answer;
  };
}

/**
 * The name did not resolve (or resolved to nothing), so there is no address to
 * classify — or to connect to. Not a {@link ProviderUrlBlockedError}: nothing
 * was refused, and a route must not answer it as if something had been.
 */
export class ProviderUrlUnresolvableError extends Error {
  constructor(message = "The provider's host name could not be resolved.") {
    super(message);
    this.name = "ProviderUrlUnresolvableError";
  }
}

/**
 * Throw {@link ProviderUrlBlockedError} if `rawUrl` is not a safe target for a
 * server-side provider fetch. See the module header for the full posture.
 *
 * Fail-open on DNS resolution failure: a host that doesn't resolve can't be
 * classified, and blocking it would reject providers that are merely
 * temporarily unreachable. A lookup that takes longer than
 * {@link PROVIDER_DNS_LOOKUP_TIMEOUT_MS} counts as a failure.
 *
 * For a check that only decides whether a value may be SAVED or EMITTED. A
 * caller that goes on to connect must use {@link resolveAllowedProviderTarget}
 * instead and pin the connection to its answer: checking here and then
 * fetching by name resolves twice, and a hostile resolver can answer the two
 * lookups differently (DNS rebinding) — or fail this one and answer the
 * fetch's with 127.0.0.1.
 */
export async function assertAllowedProviderUrl(
  rawUrl: string,
  resolver: HostResolver = resolveHostAddresses
): Promise<void> {
  try {
    await allowedProviderAddresses(rawUrl, resolver);
  } catch (err) {
    if (err instanceof ProviderUrlUnresolvableError) return; // fail open, see above
    throw err;
  }
}

/**
 * The address a probe of `rawUrl` must connect to — the one this guard just
 * classified — or a throw: {@link ProviderUrlBlockedError} for a refused
 * target, {@link ProviderUrlUnresolvableError} when the name has no answer.
 *
 * Unlike {@link assertAllowedProviderUrl} this does NOT fail open. There is
 * only one lookup, and with no answer there is nothing to connect to: the
 * request fails here instead of resolving the name a second time on its own.
 * When the name has several addresses, every one was checked and the first
 * is used.
 */
export async function resolveAllowedProviderTarget(
  rawUrl: string,
  resolver: HostResolver = resolveHostAddresses
): Promise<PinnedAddress> {
  const addresses = await allowedProviderAddresses(rawUrl, resolver);
  return toPinnedAddress(addresses[0]);
}

/**
 * Every address `rawUrl` reaches, each of which the deployment allows — at
 * least one, or a throw (see {@link resolveAllowedProviderTarget}).
 */
async function allowedProviderAddresses(rawUrl: string, resolver: HostResolver): Promise<string[]> {
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
  // throws, and the fail-open in `assertAllowedProviderUrl` then waved it
  // through.
  const literal = hostnameAsIpLiteral(url.hostname);
  if (literal !== null) {
    assertAddressesAllowed([literal]);
    return [literal];
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
    throw new ProviderUrlUnresolvableError();
  }
  if (addresses.length === 0) throw new ProviderUrlUnresolvableError();

  assertAddressesAllowed(addresses);
  return addresses;
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
