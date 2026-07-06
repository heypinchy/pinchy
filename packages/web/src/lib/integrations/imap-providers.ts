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

const PROVIDER_TABLE_ENTRIES: Record<string, ProviderConfig> = {
  "gmail.com": {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    security: "tls",
  },
  "googlemail.com": {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    security: "tls",
  },
  "outlook.com": {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    security: "tls",
  },
  "hotmail.com": {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    security: "tls",
  },
  "live.com": {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    security: "tls",
  },
  "msn.com": {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    security: "tls",
  },
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
  "fastmail.com": {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 587,
    security: "tls",
  },
  "fastmail.fm": {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 587,
    security: "tls",
  },
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
  "zoho.com": {
    imapHost: "imap.zoho.com",
    imapPort: 993,
    smtpHost: "smtp.zoho.com",
    smtpPort: 587,
    security: "tls",
  },
  "zoho.eu": {
    imapHost: "imap.zoho.eu",
    imapPort: 993,
    smtpHost: "smtp.zoho.eu",
    smtpPort: 587,
    security: "tls",
  },
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
  "mail.ru": {
    imapHost: "imap.mail.ru",
    imapPort: 993,
    smtpHost: "smtp.mail.ru",
    smtpPort: 465,
    security: "tls",
  },
  "yandex.com": {
    imapHost: "imap.yandex.com",
    imapPort: 993,
    smtpHost: "smtp.yandex.com",
    smtpPort: 465,
    security: "tls",
  },
  "yandex.ru": {
    imapHost: "imap.yandex.com",
    imapPort: 993,
    smtpHost: "smtp.yandex.com",
    smtpPort: 465,
    security: "tls",
  },
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
