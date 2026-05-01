import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

export interface WebFetchConfig {
  allowedDomains?: string[];
  excludedDomains?: string[];
  maxChars?: number;
}

const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc00:/i, /^fe80:/i,
];

// Allow up to 5 redirect hops beyond the initial request (6 HTTP calls total).
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip));
}

type ResolvedHost =
  | { kind: "literal"; address: string; family: 4 | 6 }
  | { kind: "resolved"; address: string; family: 4 | 6 }
  | { kind: "private" }
  | { kind: "unresolvable" };

async function resolveHost(hostname: string): Promise<ResolvedHost> {
  if (hostname === "localhost") return { kind: "private" };
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4) {
    return isPrivateIp(hostname)
      ? { kind: "private" }
      : { kind: "literal", address: hostname, family: 4 };
  }
  if (literalFamily === 6) {
    return isPrivateIp(hostname)
      ? { kind: "private" }
      : { kind: "literal", address: hostname, family: 6 };
  }
  const [ipv4s, ipv6s] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  const all = [...ipv4s, ...ipv6s];
  if (all.length === 0) return { kind: "unresolvable" };
  // Reject if ANY returned record is private — DNS servers controlled by an
  // attacker could mix public and private addresses to slip past a "first
  // address only" check.
  if (all.some(isPrivateIp)) return { kind: "private" };
  if (ipv4s[0]) return { kind: "resolved", address: ipv4s[0], family: 4 };
  if (ipv6s[0]) return { kind: "resolved", address: ipv6s[0], family: 6 };
  return { kind: "unresolvable" };
}

// Custom undici lookup hook that returns the pre-resolved address. This
// closes the DNS-rebinding TOCTOU window between the SSRF guard's resolve
// and fetch's own connect-time resolve — both now use the same IP.
type LookupCallback = (
  err: Error | null,
  address: string,
  family: number,
) => void;
type LookupFunction = (
  hostname: string,
  options: object,
  callback: LookupCallback,
) => void;

export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, _options, callback) => {
    callback(null, address, family);
  };
}

function buildPinnedAgent(address: string, family: 4 | 6): Agent {
  return new Agent({
    connect: { lookup: pinnedLookup(address, family) },
  });
}

// Normalize a hostname so our allow/deny comparison is case-insensitive and
// tolerates the trailing dot that DNS uses for fully-qualified names. Node's
// URL parser already lowercases, but we don't want to rely on that invariant
// silently — different callers (redirect targets, user input at other layers)
// could reintroduce mixed case.
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function checkDomainAllowed(
  hostname: string,
  config: Pick<WebFetchConfig, "allowedDomains" | "excludedDomains">,
): string | null {
  const host = normalizeHostname(hostname);
  if (config.allowedDomains?.length) {
    const allowed = config.allowedDomains.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    if (!allowed) {
      return `This agent is not allowed to fetch content from ${host}. Allowed domains: ${config.allowedDomains.join(", ")}`;
    }
  }
  if (config.excludedDomains?.length) {
    const excluded = config.excludedDomains.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
    if (excluded) {
      return `Domain ${host} is blocked for this agent.`;
    }
  }
  return null;
}

export async function webFetch(
  url: string,
  config: WebFetchConfig = {},
): Promise<{ content: string; isError?: boolean }> {
  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { content: `Invalid URL: ${url}`, isError: true };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { content: `Only HTTP/HTTPS URLs are supported.`, isError: true };
  }

  // Domain filtering
  const hostname = parsed.hostname;
  const domainError = checkDomainAllowed(hostname, config);
  if (domainError) {
    return { content: domainError, isError: true };
  }

  // SSRF guard — resolve hostname, reject private addresses, pin the
  // resolved address for the actual request to close the DNS-rebinding
  // TOCTOU window (#165).
  let resolved: ResolvedHost;
  try {
    resolved = await resolveHost(hostname);
  } catch {
    resolved = { kind: "unresolvable" };
  }
  if (resolved.kind === "private") {
    return {
      content: `Access to private network addresses is not allowed.`,
      isError: true,
    };
  }

  const maxChars = config.maxChars ?? 50000;
  let dispatcher: Agent | undefined =
    resolved.kind === "resolved"
      ? buildPinnedAgent(resolved.address, resolved.family)
      : undefined;
  try {
    let currentUrl = url;
    let res: Response | undefined;

    for (let i = 0; i <= MAX_REDIRECT_HOPS; i++) {
      res = await fetch(currentUrl, {
        headers: { "User-Agent": "PinchyBot/1.0" },
        signal: AbortSignal.timeout(30000),
        redirect: "manual",
        // dispatcher is an undici-specific extension to fetch options
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);

      if (!REDIRECT_STATUSES.has(res.status)) break;

      const location = res.headers.get("location");
      if (!location) break;

      // Resolve relative redirects
      const redirectUrl = new URL(location, currentUrl);
      if (!["http:", "https:"].includes(redirectUrl.protocol)) {
        return { content: `Redirect to unsupported protocol.`, isError: true };
      }

      // Domain filtering on redirect target
      const redirectDomainError = checkDomainAllowed(redirectUrl.hostname, config);
      if (redirectDomainError) {
        return { content: redirectDomainError, isError: true };
      }

      // SSRF check on redirect target — re-resolve and re-pin per hop.
      const redirectResolved = await resolveHost(redirectUrl.hostname);
      if (redirectResolved.kind === "private") {
        return {
          content: `Access to private network addresses is not allowed.`,
          isError: true,
        };
      }

      if (i === MAX_REDIRECT_HOPS) {
        return { content: `Too many redirects.`, isError: true };
      }

      // Swap the dispatcher to pin the new hop's address. Close the
      // previous one so its sockets don't linger.
      const previousDispatcher = dispatcher;
      dispatcher =
        redirectResolved.kind === "resolved"
          ? buildPinnedAgent(redirectResolved.address, redirectResolved.family)
          : undefined;
      previousDispatcher?.close().catch(() => {});

      currentUrl = redirectUrl.href;
    }

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      const statusText = res?.statusText ?? "Unknown";
      return {
        content: `HTTP error ${status}: ${statusText}`,
        isError: true,
      };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();

    // Extract readable content
    let extracted: string;
    if (contentType.includes("text/html")) {
      const { document } = parseHTML(text);
      const reader = new Readability(document);
      const article = reader.parse();
      extracted = article?.textContent ?? text;
    } else {
      extracted = text;
    }

    if (extracted.length > maxChars) {
      extracted = extracted.slice(0, maxChars) + "\n\n[truncated]";
    }

    return { content: extracted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Failed to fetch URL: ${message}`, isError: true };
  } finally {
    dispatcher?.close().catch(() => {});
  }
}
