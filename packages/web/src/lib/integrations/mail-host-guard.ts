import { lookup } from "node:dns/promises";
import {
  connect as netConnect,
  isIP,
  type LookupFunction,
  type NetConnectOpts,
  type Socket,
} from "node:net";
import { classifyIpAddress, type IpAddressClass } from "@/lib/integrations/url-validation";
import { pinnedLookup, toPinnedTarget, type PinnedTarget } from "@/lib/pinned-connection";

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
 *     metadata lives — the shared table files the EC2 IPv6 and Alibaba Cloud
 *     metadata addresses there too, though they sit inside private ranges) and
 *     the reserved ranges. No mail server lives there, so there is nothing to
 *     trade off.
 *   - Blocked unless `ALLOW_PRIVATE_MAIL_HOSTS=1`: the private ranges. The
 *     opt-in is the operator's explicit statement that reaching their own
 *     network is intended.
 *
 * The probes connect to the addresses this guard classified
 * (`resolveAllowedMailHost`): the socket is opened with a lookup that answers
 * only that checked set, while `host` stays the name, so SNI and certificate
 * verification still use it and the connector keeps its fallback across the
 * set (Happy Eyeballs). There is one lookup, and a DNS answer that changes
 * between check and connect (rebinding) has nothing to change. `assertMailHostAllowed` stays for callers that only check a value
 * and connect to nothing.
 *
 * Not covered: pinchy-email, in the OpenClaw container, resolves the stored
 * host itself for every real IMAP/SMTP session, and `stored-destination.ts`'s
 * re-check at credential fetch is again check-then-someone-else-connects.
 * Pinchy can pin only the sockets it opens.
 */

export class MailHostBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailHostBlockedError";
  }
}

/** Resolves a host to its IP addresses. Injected in tests. */
export type MailHostResolver = (host: string) => Promise<string[]>;

// Typed against IpAddressClass so a misspelt class is a compile error rather
// than an entry that never matches — the failure mode of a security list is
// that it silently lets things through.
const ALWAYS_BLOCKED_CLASSES: ReadonlySet<IpAddressClass> = new Set([
  "loopback",
  "unspecified",
  "link-local",
  "reserved",
]);

const INTERNAL_MESSAGE =
  "Blocked: this host resolves to a loopback, link-local, cloud-metadata or otherwise reserved address.";

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

// A DNS hostname (RFC 1123): dot-separated labels of letters, digits and
// inner hyphens (and underscores, common on internal mail servers — the guard
// resolves the exact string, so guard and client read the `_` the same way),
// at most 63 characters each and 253 in all, with an optional
// trailing dot for a fully-qualified name. An internationalised name is
// accepted in its punycode form (`xn--…`), which is what DNS actually carries.
const HOSTNAME =
  /^(?=.{1,253}\.?$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*\.?$/i;

/**
 * Is `host` something every resolver reads the same way?
 *
 * imapflow and nodemailer hand the stored host to the resolver unchanged, so
 * the guard has to resolve that same string — and the string must not be one
 * that resolvers disagree on. The guard used to check a normalised copy
 * (trimmed, brackets and anything after a `%` dropped): `a%b.attacker.test`
 * was checked as `a`, `[a.attacker.test` as `a.attacker.test`. glibc and
 * c-ares (our node:22-slim images) refuse the raw strings; musl, measured,
 * queries them and connects to the answer. So: a hostname, or a bare IP
 * literal. No brackets (neither client strips them), no zone ID (an interface
 * on Pinchy's own host means nothing for a remote mail server), no raw Unicode
 * (neither client converts it to punycode).
 */
function isPlainHost(host: string): boolean {
  return HOSTNAME.test(host) || (/^[0-9a-f:.]+$/i.test(host) && isIP(host) !== 0);
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
  assertPlainHost(host);

  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return;
  }

  assertAddressesAllowed(addresses);
}

/**
 * The addresses a connection to `host` may use — every one this guard just
 * classified — or a throw.
 *
 * For the callers that CONNECT. {@link assertMailHostAllowed} followed by a
 * connect by name resolves twice, and a resolver can answer the two lookups
 * differently (DNS rebinding): public for the check, 127.0.0.1 for the
 * socket. Here there is one lookup and its answers are the destination.
 *
 * A lookup that fails is rethrown unchanged instead of passing: with one
 * resolution there is no later connect to "fail naturally", and the original
 * `ENOTFOUND` keeps the probe's "could not resolve the host" message for the
 * typo case. Every address was checked, so all of them are returned and the
 * connector (see {@link connectPinned}, {@link pinnedImapOptions}) may fall
 * back from a dead first record or a broken IPv6 path to the next one, as it
 * does for an unpinned host.
 */
export async function resolveAllowedMailHost(
  host: string,
  resolver: MailHostResolver = resolveViaDns
): Promise<PinnedTarget> {
  assertPlainHost(host);

  // An address literal is its own answer; a resolver has nothing to add.
  const addresses = isIP(host) !== 0 ? [host] : await resolver(host);
  if (addresses.length === 0) {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  }

  assertAddressesAllowed(addresses);
  return toPinnedTarget(addresses.map(normalizeAddress));
}

function assertPlainHost(host: string): void {
  if (!isPlainHost(host)) {
    throw new MailHostBlockedError(
      "Blocked: enter the mail server as a plain host name or IP address, like imap.example.com, " +
        "with no spaces, brackets, port or zone ID. An internationalised name goes in its xn-- form."
    );
  }
}

function assertAddressesAllowed(addresses: string[]): void {
  const allowPrivate = process.env.ALLOW_PRIVATE_MAIL_HOSTS === "1";

  for (const address of addresses) {
    const normalized = normalizeAddress(address);
    const addressClass = classifyIpAddress(normalized);

    if (addressClass !== null && ALWAYS_BLOCKED_CLASSES.has(addressClass)) {
      throw new MailHostBlockedError(INTERNAL_MESSAGE);
    }
    if (addressClass === "private" && !allowPrivate) {
      throw new MailHostBlockedError(PRIVATE_MESSAGE);
    }
  }
}

/**
 * Where imapflow must connect: the hostname stays `host` (SNI and the
 * certificate check use it; an IP literal gets no `servername`), and `tls`
 * carries a lookup that answers only the checked addresses. imapflow builds
 * its connect options as `Object.assign({ host, servername, port }, tls)`, so
 * `lookup` and `autoSelectFamily` reach `net.connect`/`tls.connect` and keep
 * Node's fallback across the set.
 */
export function pinnedImapOptions(host: string, target: PinnedTarget) {
  return {
    host,
    tls: {
      lookup: pinnedLookup(target) as unknown as LookupFunction,
      autoSelectFamily: true,
    },
  };
}

/**
 * A TCP connection to `host:port` that can reach only the checked addresses,
 * trying them in turn (`autoSelectFamily`). Resolves once connected.
 */
export function connectPinned(
  host: string,
  port: number,
  target: PinnedTarget,
  timeoutMs: number
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({
      host,
      port,
      lookup: pinnedLookup(target),
      autoSelectFamily: true,
    } as unknown as NetConnectOpts);
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Where nodemailer must connect. nodemailer resolves a hostname itself (its
 * own resolver, not `tls.lookup`), so the pinned socket is opened here and
 * handed over through `getSocket`; nodemailer then runs TLS or STARTTLS over
 * it with `host` — the name — for SNI and the certificate check. An IP
 * literal gets no servername from nodemailer.
 */
export function pinnedSmtpOptions(
  host: string,
  port: number,
  target: PinnedTarget,
  timeoutMs: number
) {
  return {
    host,
    getSocket(
      _options: unknown,
      callback: (error: Error | null, socketOptions?: { connection: Socket }) => void
    ) {
      connectPinned(host, port, target, timeoutMs).then(
        (connection) => callback(null, { connection }),
        (error: Error) => callback(error)
      );
    },
  };
}
