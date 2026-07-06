/**
 * IMAP/SMTP autodiscovery: given a user-typed email address, produce
 * best-effort host/port/security candidates to PREFILL the "add email
 * connection" form. Nothing here ever connects to a mail server — the user
 * always confirms and runs "test connection" before saving.
 *
 * Offline-first: Pinchy must work air-gapped, so resolution goes through
 * three fallback tiers, each strictly more speculative than the last:
 *
 *   1. `lookupProviderTable` — bundled, zero-network, authoritative for the
 *      ~20-30 providers in imap-providers.ts.
 *   2. `discoverViaSrv` — RFC 6186 DNS-SRV records (`_imaps._tcp.<domain>`,
 *      `_submission._tcp.<domain>`). Best-effort; absent/failing DNS (e.g. an
 *      air-gapped deployment) degrades to an empty result, never a throw.
 *   3. A plain hostname guess (`imap.<domain>` / `smtp.<domain>`) — no
 *      network at all, just a convention most providers follow.
 *
 * A fourth tier — fetching a provider's `.well-known` HTTP autoconfig
 * document — is intentionally NOT implemented for v1. That fetch's URL would
 * be derived from a user-supplied domain, which is real SSRF surface, and
 * DNS-SRV + the provider table + the guess already cover the cases that
 * matter for a prefill-only feature. `isSafeAutodiscoverUrl` below still
 * ships as the guard a future HTTP stage would need, so it can be exercised
 * and reviewed independently of that stage ever landing.
 *
 * `autodiscover` is the only export most callers need and it MUST NEVER
 * THROW — any failure in any tier degrades to the next tier, down to the
 * plain guess.
 */
import {
  lookupProviderTable,
  type ProviderConfig,
  type MailSecurity,
} from "@/lib/integrations/imap-providers";

export type { ProviderConfig, MailSecurity };

export type DiscoveredConfig = ProviderConfig;

export type AutodiscoverSource = "provider-table" | "dns-srv" | "guess" | "none";

export interface AutodiscoverResult {
  config: Partial<DiscoveredConfig>;
  source: AutodiscoverSource;
}

/** Shape of an RFC 2782 SRV record, matching Node's `dns/promises`.resolveSrv. */
export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

/** Injected DNS resolver dependency — matches Node's `dns/promises` shape. */
export interface SrvResolver {
  resolveSrv(hostname: string): Promise<SrvRecord[]>;
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];

/** True if `hostname` is an IPv4 dotted-quad literal (any range, private or public). */
function isIPv4Literal(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/** True if `hostname` (as returned by `new URL().hostname`, brackets stripped) is an IPv6 literal. */
function isIPv6Literal(hostname: string): boolean {
  // `URL.hostname` keeps the brackets for IPv6 (e.g. "[::1]"); strip them.
  const addr = hostname.replace(/^\[|\]$/g, "");
  // A conservative check: IPv6 literals contain a colon; hostnames never do.
  return addr.includes(":");
}

/**
 * SSRF guard for any HTTP fetch whose URL is derived from a user-supplied
 * email domain. Default-deny: returns true ONLY when every check below
 * passes. Any parse failure or ambiguity returns false.
 */
export function isSafeAutodiscoverUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;

  // WHATWG URL does not strip a trailing FQDN dot (e.g. "localhost." parses
  // as hostname "localhost."), but a trailing-dot hostname resolves to the
  // exact same destination as its non-dotted form. Normalize it away before
  // any blocklist/suffix comparison so "localhost." can't bypass the guard
  // that "localhost" is subject to.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.length === 0) return false;

  if (BLOCKED_HOSTNAMES.has(hostname)) return false;
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;

  // Reject ALL IP literals, public or private — a discovered autodiscovery
  // host must be a DNS name. This is intentionally broader than "just block
  // private ranges": it's simpler to reason about, and it still catches
  // metadata/loopback/link-local addresses (169.254.169.254, 127.0.0.1, ...)
  // without needing to enumerate every reserved range.
  if (isIPv6Literal(hostname)) return false;
  if (isIPv4Literal(hostname)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// DNS-SRV discovery (RFC 6186)
// ---------------------------------------------------------------------------

function pickHighestPriority(records: SrvRecord[]): SrvRecord | undefined {
  if (records.length === 0) return undefined;
  return records.reduce((best, current) => (current.priority < best.priority ? current : best));
}

async function resolveSrvSafely(
  resolver: SrvResolver,
  name: string
): Promise<SrvRecord | undefined> {
  try {
    const records = await resolver.resolveSrv(name);
    return pickHighestPriority(records);
  } catch {
    // NXDOMAIN, timeout, no DNS available (air-gapped) — degrade silently.
    return undefined;
  }
}

/**
 * RFC 6186 DNS-SRV discovery. Looks up `_imaps._tcp.<domain>` and
 * `_submission._tcp.<domain>` via the injected resolver. Never throws: each
 * lookup is caught independently so one failing record doesn't blank the
 * other, and a fully-failing resolver (e.g. no DNS at all) yields `{}`.
 */
export async function discoverViaSrv(
  domain: string,
  resolver: SrvResolver
): Promise<Partial<DiscoveredConfig>> {
  const [imapRecord, smtpRecord] = await Promise.all([
    resolveSrvSafely(resolver, `_imaps._tcp.${domain}`),
    resolveSrvSafely(resolver, `_submission._tcp.${domain}`),
  ]);

  const result: Partial<DiscoveredConfig> = {};
  if (imapRecord) {
    result.imapHost = imapRecord.name;
    result.imapPort = imapRecord.port;
  }
  if (smtpRecord) {
    result.smtpHost = smtpRecord.name;
    result.smtpPort = smtpRecord.port;
  }
  if (imapRecord || smtpRecord) {
    result.security = "tls";
  }
  return result;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AutodiscoverDeps {
  resolver?: SrvResolver;
  fetchImpl?: typeof fetch;
  providerTable?: (domain: string) => ProviderConfig | null;
}

/** Extract and lowercase the domain from an email address, or undefined if malformed. */
function extractDomain(email: string): string | undefined {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  const domain = trimmed.slice(at + 1).toLowerCase();
  // Minimal sanity check: must look like a domain (has a dot, no spaces).
  if (!/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain)) return undefined;
  return domain;
}

async function defaultResolver(): Promise<SrvResolver> {
  const dns = await import("node:dns/promises");
  return { resolveSrv: (name: string) => dns.resolveSrv(name) };
}

function guessConfig(domain: string): DiscoveredConfig {
  return {
    imapHost: `imap.${domain}`,
    imapPort: 993,
    smtpHost: `smtp.${domain}`,
    smtpPort: 587,
    security: "tls",
  };
}

/**
 * Orchestrates provider-table -> DNS-SRV -> guess resolution for a user-typed
 * email address. NEVER throws — every tier degrades to the next on any
 * error, so this always resolves with at least a guessed config (unless the
 * email itself is unparseable, in which case `source: "none"`).
 */
export async function autodiscover(
  email: string,
  deps: AutodiscoverDeps = {}
): Promise<AutodiscoverResult> {
  try {
    const domain = extractDomain(email);
    if (!domain) return { config: {}, source: "none" };

    const providerTable = deps.providerTable ?? lookupProviderTable;
    const tableHit = providerTable(domain);
    if (tableHit) return { config: tableHit, source: "provider-table" };

    try {
      const resolver = deps.resolver ?? (await defaultResolver());
      const srvResult = await discoverViaSrv(domain, resolver);
      if (srvResult.imapHost) return { config: srvResult, source: "dns-srv" };
    } catch {
      // Resolver construction or lookup failed entirely (e.g. no DNS module
      // available, or every lookup rejected) — fall through to the guess.
    }

    return { config: guessConfig(domain), source: "guess" };
  } catch {
    // Absolute last resort: something unexpected happened outside the tiers
    // above (should not normally be reachable). Never propagate a throw to
    // callers of a prefill-only helper.
    return { config: {}, source: "none" };
  }
}
