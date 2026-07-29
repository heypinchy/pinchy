import { lookup } from "node:dns/promises";
import {
  canonicalizeIpAddress,
  classifyIpAddress,
  type IpAddressClass,
} from "@/lib/integrations/url-validation";

/**
 * SSRF guard for the IMAP/SMTP probes.
 *
 * The "Test connection" endpoint connects to an admin-supplied host:port and
 * reports *why* the attempt failed — refused, timed out, TLS error, auth
 * rejected. Those distinctions are the whole point of the diagnostic, and they
 * are also exactly what makes an unguarded probe an internal port scanner: it
 * answers "is there something listening on 10.0.0.5:6379, and does it speak
 * TLS?" one request at a time (pinchy#823).
 *
 * Unlike `validateExternalUrl`, which checks a URL string, this guard RESOLVES
 * the host first: a mail host is a bare name, and the interesting attack is a
 * public DNS name with an internal A record.
 *
 * Two tiers, because an on-premise mail server on an RFC-1918 range is a
 * legitimate deployment:
 *
 *   - Always blocked: loopback, unspecified, link-local (which is where cloud
 *     metadata lives) and the EC2 IPv6 metadata address. No mail server lives
 *     there, so there is nothing to trade off.
 *   - Blocked unless `ALLOW_PRIVATE_MAIL_HOSTS=1`: the private ranges. The
 *     opt-in is the operator's explicit statement that reaching their own
 *     network is intended.
 *
 * Caveat, same as the rest of the app's SSRF checks: this resolves once and the
 * mail library resolves again when it connects, so a DNS answer that changes
 * between the two (rebinding) is not covered. Closing that would mean pinning
 * the connection to the address we checked, which neither imapflow nor
 * nodemailer exposes.
 */

export class MailHostBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailHostBlockedError";
  }
}

/** Resolves a host to its IP addresses. Injected in tests. */
export type MailHostResolver = (host: string) => Promise<string[]>;

// EC2's IPv6 instance-metadata endpoint. It sits inside fc00::/7, so the
// private-range check already covers it — but only while the opt-in flag is
// off, and reaching IMDS must not become collateral of an operator enabling
// their on-premise mail server. Canonicalized so no alternate spelling of the
// same address slips past the comparison.
const ALWAYS_BLOCKED_ADDRESSES: ReadonlySet<string> = new Set(
  ["fd00:ec2::254"].map((address) => {
    const canonical = canonicalizeIpAddress(address);
    // A typo in this list would canonicalize to null and silently stop
    // blocking anything. Fail at import instead of shipping a dead entry.
    if (canonical === null) throw new Error(`Not an IP address: ${address}`);
    return canonical;
  })
);

// Typed against IpAddressClass so a misspelt class is a compile error rather
// than an entry that never matches — the failure mode of a security list is
// that it silently lets things through.
const ALWAYS_BLOCKED_CLASSES: ReadonlySet<IpAddressClass> = new Set([
  "loopback",
  "unspecified",
  "link-local",
]);

const INTERNAL_MESSAGE =
  "Blocked: this host resolves to a loopback, link-local, or cloud-metadata address.";

const PRIVATE_MESSAGE =
  "Blocked: this host resolves to a private network address. " +
  "Set ALLOW_PRIVATE_MAIL_HOSTS=1 to allow an on-premise mail server.";

async function resolveViaDns(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function normalizeAddress(address: string): string {
  return address
    .replace(/^\[|\]$/g, "")
    .split("%")[0]
    .toLowerCase();
}

/**
 * Throws `MailHostBlockedError` if `host` resolves to an address the probe must
 * not touch. Resolves silently otherwise.
 *
 * A host that does not resolve at all is allowed through: no address means no
 * connection, so there is no oracle to protect — and the far more common cause
 * is a typo, which deserves the probe's "could not resolve the host" message
 * rather than a security error the admin cannot act on.
 */
export async function assertMailHostAllowed(
  host: string,
  resolver: MailHostResolver = resolveViaDns
): Promise<void> {
  const normalizedHost = normalizeAddress(host.trim());
  if (normalizedHost.length === 0) {
    // The schemas already require a non-empty host, so this is a belt-and-
    // suspenders guard for a future caller — say what is actually wrong rather
    // than reusing the internal-address wording.
    throw new MailHostBlockedError("Blocked: no mail server host was given.");
  }

  let addresses: string[];
  try {
    addresses = await resolver(normalizedHost);
  } catch {
    return;
  }

  const allowPrivate = process.env.ALLOW_PRIVATE_MAIL_HOSTS === "1";

  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    const addressClass = classifyIpAddress(normalized);
    const canonical = canonicalizeIpAddress(normalized);

    if (
      (canonical !== null && ALWAYS_BLOCKED_ADDRESSES.has(canonical)) ||
      (addressClass !== null && ALWAYS_BLOCKED_CLASSES.has(addressClass))
    ) {
      throw new MailHostBlockedError(INTERNAL_MESSAGE);
    }
    if (addressClass === "private" && !allowPrivate) {
      throw new MailHostBlockedError(PRIVATE_MESSAGE);
    }
  }
}
