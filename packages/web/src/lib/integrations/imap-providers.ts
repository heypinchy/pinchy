/**
 * Bundled, offline table of common consumer/business email providers' IMAP +
 * SMTP endpoints, keyed by mailbox domain. This is the authoritative,
 * zero-network first stop for IMAP autodiscovery (see imap-autodiscover.ts):
 * Pinchy must keep working air-gapped, so a hit here short-circuits the DNS
 * lookups and (never-implemented-for-v1) HTTP autoconfig stage entirely.
 *
 * Values are the provider-documented IMAP/SMTP host+port+security triples.
 * Ports follow the two standard schemes unless a provider documents
 * something else:
 *   - `tls`: implicit TLS from connection start (IMAP 993, SMTP submission 465)
 *   - `starttls`: plaintext connection upgraded via STARTTLS (SMTP submission 587)
 */

export type MailSecurity = "tls" | "starttls";

export interface ProviderConfig {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  security: MailSecurity;
}

// Proton Mail deliberately excluded: it does not expose IMAP/SMTP directly
// to third-party clients — it requires running Proton Mail Bridge locally,
// which listens on 127.0.0.1 on the *user's own machine* at a port Bridge
// picks per-install. There is no fixed public host to put in this table, and
// hardcoding a localhost address here would be indistinguishable from (and
// just as dangerous as) defeating the SSRF guard in imap-autodiscover.ts —
// autodiscovery results are meant to be safe, provider-controlled network
// endpoints, not loopback addresses. Users with Proton must enter Bridge's
// host/port manually.

// Providers referenced from BOTH the domain table below and the MX-suffix
// table further down are named constants here so the two tables share the
// exact same object — never two literals that could drift apart.
const GMAIL_CONFIG: ProviderConfig = {
  imapHost: "imap.gmail.com",
  imapPort: 993,
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  security: "tls",
};

const OUTLOOK_CONFIG: ProviderConfig = {
  imapHost: "outlook.office365.com",
  imapPort: 993,
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  security: "tls",
};

const FASTMAIL_CONFIG: ProviderConfig = {
  imapHost: "imap.fastmail.com",
  imapPort: 993,
  smtpHost: "smtp.fastmail.com",
  smtpPort: 587,
  security: "tls",
};

const ZOHO_COM_CONFIG: ProviderConfig = {
  imapHost: "imap.zoho.com",
  imapPort: 993,
  smtpHost: "smtp.zoho.com",
  smtpPort: 587,
  security: "tls",
};

const ZOHO_EU_CONFIG: ProviderConfig = {
  imapHost: "imap.zoho.eu",
  imapPort: 993,
  smtpHost: "smtp.zoho.eu",
  smtpPort: 587,
  security: "tls",
};

const MAIL_RU_CONFIG: ProviderConfig = {
  imapHost: "imap.mail.ru",
  imapPort: 993,
  smtpHost: "smtp.mail.ru",
  smtpPort: 465,
  security: "tls",
};

const YANDEX_CONFIG: ProviderConfig = {
  imapHost: "imap.yandex.com",
  imapPort: 993,
  smtpHost: "smtp.yandex.com",
  smtpPort: 465,
  security: "tls",
};

// Migadu (used by e.g. helmcraft.ai): no SRV records are published, so this
// domain used to fall through DNS-SRV straight to the wrong `imap.<domain>`
// guess. Its MX records (aspmx1/aspmx2.migadu.com) identify it unambiguously
// — see `lookupProviderByMx` below.
const MIGADU_CONFIG: ProviderConfig = {
  imapHost: "imap.migadu.com",
  imapPort: 993,
  smtpHost: "smtp.migadu.com",
  smtpPort: 465,
  security: "tls",
};

const PROVIDER_TABLE_ENTRIES: Record<string, ProviderConfig> = {
  "gmail.com": GMAIL_CONFIG,
  "googlemail.com": GMAIL_CONFIG,
  "outlook.com": OUTLOOK_CONFIG,
  "hotmail.com": OUTLOOK_CONFIG,
  "live.com": OUTLOOK_CONFIG,
  "msn.com": OUTLOOK_CONFIG,
  "yahoo.com": {
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    security: "tls",
  },
  "yahoo.co.uk": {
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    security: "tls",
  },
  "ymail.com": {
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    security: "tls",
  },
  "icloud.com": {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    security: "tls",
  },
  "me.com": {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    security: "tls",
  },
  "mac.com": {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    security: "tls",
  },
  "fastmail.com": FASTMAIL_CONFIG,
  "fastmail.fm": FASTMAIL_CONFIG,
  "gmx.net": {
    imapHost: "imap.gmx.net",
    imapPort: 993,
    smtpHost: "mail.gmx.net",
    smtpPort: 587,
    security: "tls",
  },
  "gmx.de": {
    imapHost: "imap.gmx.net",
    imapPort: 993,
    smtpHost: "mail.gmx.net",
    smtpPort: 587,
    security: "tls",
  },
  "gmx.com": {
    imapHost: "imap.gmx.com",
    imapPort: 993,
    smtpHost: "mail.gmx.com",
    smtpPort: 587,
    security: "tls",
  },
  "web.de": {
    imapHost: "imap.web.de",
    imapPort: 993,
    smtpHost: "smtp.web.de",
    smtpPort: 587,
    security: "tls",
  },
  "t-online.de": {
    imapHost: "secureimap.t-online.de",
    imapPort: 993,
    smtpHost: "securesmtp.t-online.de",
    smtpPort: 587,
    security: "tls",
  },
  "zoho.com": ZOHO_COM_CONFIG,
  "zoho.eu": ZOHO_EU_CONFIG,
  "migadu.com": MIGADU_CONFIG,
  "aol.com": {
    imapHost: "imap.aol.com",
    imapPort: 993,
    smtpHost: "smtp.aol.com",
    smtpPort: 587,
    security: "tls",
  },
  "att.net": {
    imapHost: "imap.mail.att.net",
    imapPort: 993,
    smtpHost: "smtp.mail.att.net",
    smtpPort: 465,
    security: "tls",
  },
  "comcast.net": {
    imapHost: "imap.comcast.net",
    imapPort: 993,
    smtpHost: "smtp.comcast.net",
    smtpPort: 587,
    security: "tls",
  },
  "verizon.net": {
    imapHost: "incoming.verizon.net",
    imapPort: 993,
    smtpHost: "outgoing.verizon.net",
    smtpPort: 587,
    security: "tls",
  },
  "mail.ru": MAIL_RU_CONFIG,
  "yandex.com": YANDEX_CONFIG,
  "yandex.ru": YANDEX_CONFIG,
  "qq.com": {
    imapHost: "imap.qq.com",
    imapPort: 993,
    smtpHost: "smtp.qq.com",
    smtpPort: 587,
    security: "tls",
  },
  "163.com": {
    imapHost: "imap.163.com",
    imapPort: 993,
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    security: "tls",
  },
};

// A `Map` (rather than a plain object) so lookups by an attacker-controlled
// key can never resolve to a prototype-chain value (e.g. `Object.prototype`
// via "__proto__", or the `Object` constructor via "constructor") and can
// never trip a `security/detect-object-injection` sink — `Map#get` is not a
// dynamic property access.
const PROVIDER_TABLE: ReadonlyMap<string, ProviderConfig> = new Map(
  Object.entries(PROVIDER_TABLE_ENTRIES)
);

/**
 * Look up the bundled provider config for a mailbox domain. Case-insensitive.
 * Returns null for domains not in the table (custom/business domains, which
 * fall through to DNS-SRV discovery and finally a best-effort guess), and for
 * prototype-chain lookalikes like "__proto__" or "constructor" — `Map` has no
 * prototype-chain fallback, so those simply miss like any other unknown key.
 */
export function lookupProviderTable(domain: string): ProviderConfig | null {
  const key = domain.trim().toLowerCase();
  return PROVIDER_TABLE.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// MX-record-based provider detection
// ---------------------------------------------------------------------------
//
// A custom/business domain (e.g. helmcraft.ai) is often hosted at a provider
// that publishes no DNS-SRV records at all, so `lookupProviderTable` (keyed
// on the mailbox domain itself) and `discoverViaSrv` in imap-autodiscover.ts
// both miss it — autodiscovery used to fall straight through to a guessed
// `imap.<domain>` host, which is simply wrong for hosted mail (Migadu, for
// instance, serves IMAP from imap.migadu.com, never imap.<customer-domain>).
//
// The domain's MX records say who accepts its mail even when they say
// nothing about how to connect to it, so this table maps well-known MX
// *hostname suffixes* to the same bundled `ProviderConfig`s used above.
// Thunderbird's autoconfig uses the same trick.
//
// This is an array of [suffix, config] TUPLES, not a plain object or a
// suffix->config `Map` keyed for direct `.get()` lookup, for two reasons:
// matching a suffix requires scanning (an exact-key Map can't do
// "endsWith"), and using tuples/Map entries — rather than indexing a plain
// object with an attacker-influenced string — keeps this immune to the same
// prototype-injection concern `PROVIDER_TABLE` above guards against.
const MX_SUFFIX_TABLE: ReadonlyArray<readonly [string, ProviderConfig]> = [
  ["migadu.com", MIGADU_CONFIG],
  // Google Workspace / Gmail MX hosts look like "aspmx.l.google.com",
  // "alt1.aspmx.l.google.com", etc. — all under the "google.com" suffix.
  ["google.com", GMAIL_CONFIG],
  ["googlemail.com", GMAIL_CONFIG],
  ["mail.protection.outlook.com", OUTLOOK_CONFIG],
  ["fastmail.com", FASTMAIL_CONFIG],
  ["messagingengine.com", FASTMAIL_CONFIG],
  ["zoho.com", ZOHO_COM_CONFIG],
  ["zoho.eu", ZOHO_EU_CONFIG],
  ["mail.ru", MAIL_RU_CONFIG],
  ["yandex.net", YANDEX_CONFIG],
];

/**
 * Look up a bundled provider config from a list of MX hostnames (typically
 * the `exchange` values of a domain's MX records, already sorted by
 * priority). Returns the first suffix match, or null if none of the hosts
 * match a known provider.
 *
 * SECURITY: this returns ONLY fixed, well-known `ProviderConfig` objects
 * from the table above — never a host/port derived from the MX hostname
 * itself. An attacker who controls a target domain's DNS (and therefore its
 * MX records) can at most steer this function to select one of the
 * hardcoded providers already in this file; they can never inject an
 * arbitrary connect target. That's why matching is a suffix check, not a
 * template substitution.
 *
 * Matching is a strict label-boundary suffix match: `host === suffix` or
 * `host.endsWith("." + suffix)`. A bare `endsWith(suffix)` would be wrong —
 * it would let a hostile domain like "evilmigadu.com" match the "migadu.com"
 * suffix even though "evilmigadu.com" is not a subdomain of migadu.com at
 * all.
 */
export function lookupProviderByMx(mxHosts: string[]): ProviderConfig | null {
  for (const rawHost of mxHosts) {
    // Lowercase and strip a trailing FQDN dot (DNS answers commonly include
    // one, e.g. "aspmx1.migadu.com.") before comparing against the suffix
    // table.
    const host = rawHost.trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;

    for (const [suffix, config] of MX_SUFFIX_TABLE) {
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        return config;
      }
    }
  }
  return null;
}
