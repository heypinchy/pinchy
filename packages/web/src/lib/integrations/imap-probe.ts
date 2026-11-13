import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ImapTestInput } from "@/lib/schemas/imap";
import {
  connectPinned,
  MailHostBlockedError,
  pinnedImapOptions,
  pinnedSmtpOptions,
  resolveAllowedMailHost,
} from "@/lib/integrations/mail-host-guard";
import type { PinnedTarget } from "@/lib/pinned-connection";

// Shared IMAP/SMTP probe logic used by BOTH:
//   - the pre-create "Test Connection" route (packages/web/src/app/api/integrations/imap/test/route.ts)
//   - the imap branch of probeIntegrationCredentials (packages/web/src/lib/integrations/probe.ts),
//     which re-probes an EXISTING connection's stored credentials.
// Kept in one place (DRY) so timeout bounds, error-message mapping and the SSRF
// guard never drift between the two callers — the guard lives at the two entry
// points below (testImapLogin/testSmtpVerify) precisely so neither caller can
// forget it.

// Everything an error says, for classification. A connect over several
// addresses that all fail rejects with an AggregateError: empty message, and
// the codes live on `errors`. Matching only `message` would read that as an
// unknown failure.
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { code, errors } = error as Error & { code?: unknown; errors?: unknown };
  const parts: string[] = [typeof code === "string" ? code : "", error.message];
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const e = inner as { code?: unknown; message?: unknown } | null;
      parts.push(`${typeof e?.code === "string" ? e.code : ""} ${String(e?.message ?? inner)}`);
    }
  }
  return parts.join(" ");
}

// Maps low-level probe errors to short, friendly messages that never leak a
// stack trace or the password. Order matters: unambiguous network-error CODES
// are matched BEFORE the fuzzy "auth" wordlist, because that wordlist matches
// against the whole message — which includes the (user-controlled) hostname.
// A host named e.g. "smtp-auth.example.com" would otherwise turn a DNS/timeout/
// refused failure into a bogus "authentication failed".
export function friendlyError(error: unknown): string {
  // The SSRF guard's own message already names the cause and the fix; the
  // fuzzy mapping below would only bury it under "check your settings".
  if (error instanceof MailHostBlockedError) return error.message;

  const lower = errorText(error).toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("etimedout")) {
    return "Connection timed out — check the host and port";
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("ehostunreach") ||
    lower.includes("could not connect")
  ) {
    return "Could not connect to the server — check the host and port";
  }
  if (
    lower.includes("auth") ||
    lower.includes("invalid login") ||
    lower.includes("invalid credentials") ||
    lower.includes("535")
  ) {
    return "Authentication failed — check the username and password";
  }
  if (lower.includes("certificate") || lower.includes("self signed") || lower.includes("ssl")) {
    return "Could not establish a secure connection — check the security setting";
  }
  return "Connection failed — check your settings and try again";
}

// Structured counterpart to friendlyError(): a machine-readable `code` plus a
// human-readable message, so callers (the IMAP test route) can branch on the
// failure category — e.g. to decide whether it's worth probing raw SMTP port
// reachability — instead of pattern-matching the friendly string again.
// friendlyError() itself is kept unchanged/exported for its existing callers.
export type ProbeFailureCode =
  "timeout" | "refused" | "dns" | "auth" | "tls" | "blocked" | "unknown";

// Per-leg (IMAP or SMTP) outcome of a connection test — see ImapTestResult in
// @/lib/schemas/imap for how the two legs combine into the full API response.
export type LegResult = { ok: true } | { ok: false; code: ProbeFailureCode; message: string };

export function classifyProbeError(error: unknown): { code: ProbeFailureCode; message: string } {
  // Its own code, ahead of every message-shaped rule: the caller uses the code
  // to decide whether to run the SMTP port-reachability probe, and a host the
  // guard just refused must not be scanned on three more ports.
  if (error instanceof MailHostBlockedError) return { code: "blocked", message: error.message };

  const lower = errorText(error).toLowerCase();

  // Unambiguous network-error CODES first. The "auth" branch below matches a
  // fuzzy wordlist against the whole message — which includes the
  // (user-controlled) hostname — so a host named e.g. "smtp-auth.example.com"
  // would otherwise misclassify a DNS/timeout/refused failure as "auth" and
  // wrongly skip the SMTP port-reachability probe the caller runs for
  // connection-level failures.
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("etimedout")) {
    return {
      code: "timeout",
      message:
        "Connection timed out — cloud hosts often block this port; try a different port or check the host and port",
    };
  }
  if (lower.includes("econnrefused")) {
    return { code: "refused", message: "Connection refused — check the host and port" };
  }
  if (lower.includes("enotfound") || lower.includes("eai_again")) {
    return { code: "dns", message: "Could not resolve the host — check the hostname" };
  }
  if (lower.includes("ehostunreach") || lower.includes("could not connect")) {
    return {
      code: "refused",
      message: "Could not connect to the server — check the host and port",
    };
  }
  if (
    lower.includes("auth") ||
    lower.includes("invalid login") ||
    lower.includes("invalid credentials") ||
    lower.includes("535")
  ) {
    return { code: "auth", message: "Authentication failed — check the username and password" };
  }
  if (lower.includes("certificate") || lower.includes("self signed") || lower.includes("ssl")) {
    return {
      code: "tls",
      message: "Could not establish a secure connection — check the security setting",
    };
  }
  return { code: "unknown", message: "Connection failed — check your settings and try again" };
}

export type SmtpPortProbe = { port: number; reachable: boolean };

// Bound the raw TCP probe so a filtered/black-holed port can't hang the
// user-facing request. This is deliberately just a TCP connect — no TLS
// handshake, no auth — since all we need to know is whether the OS-level
// connection succeeds within a reasonable time.
const SMTP_PORT_PROBE_TIMEOUT_MS = 2500;

// Connects through the pinned lookup, so a first address that refuses falls
// through to the next checked one instead of reading as "unreachable".
async function probeTcpPort(
  host: string,
  port: number,
  target: PinnedTarget,
  timeoutMs: number
): Promise<boolean> {
  try {
    const socket = await connectPinned(host, port, target, timeoutMs);
    // destroy() can still emit a late 'error'; with no listener that would
    // crash the process.
    socket.on("error", () => {});
    socket.destroy();
    return true;
  } catch {
    return false;
  }
}

// SECURITY: this connects ONLY to the caller-supplied smtpHost on a fixed,
// hardcoded port list — never to a host/port derived from user-controlled
// input beyond what the caller intended to probe. Do not widen this to accept
// arbitrary ports/hosts.
//
// It runs the SSRF guard itself and scans the address the guard classified.
// Its caller runs it after the SMTP leg already resolved the host, but that
// was a separate lookup: a name that answers a public address for the leg and
// an internal one now must not be scanned. A host the guard refuses, or that
// does not resolve, reads as "nothing reachable" — the port hint is advice,
// and there is no address to give it about.
export async function probeSmtpPorts(
  host: string,
  ports: number[] = [465, 587, 25]
): Promise<SmtpPortProbe[]> {
  let target: PinnedTarget;
  try {
    target = await resolveAllowedMailHost(host);
  } catch {
    return ports.map((port) => ({ port, reachable: false }));
  }
  return Promise.all(
    ports.map(async (port) => ({
      port,
      reachable: await probeTcpPort(host, port, target, SMTP_PORT_PROBE_TIMEOUT_MS),
    }))
  );
}

// A single `security` field can't be simultaneously correct for IMAP
// (implicit-TLS 993) and SMTP (STARTTLS submission 587), so TLS mode is keyed
// off the standard port:
//   security === "none"        → no encryption          (secure:false, requireTLS:false)
//   implicit-TLS ports 993/465 → implicit TLS           (secure:true,  requireTLS:false)
//   any other port (143/587/25)→ STARTTLS opportunistic (secure:false, requireTLS:true)
const IMPLICIT_TLS_PORTS = new Set([993, 465]);
export function tlsModeForPort(
  port: number,
  security: string
): { secure: boolean; requireTLS: boolean } {
  if (security === "none") return { secure: false, requireTLS: false };
  const implicit = IMPLICIT_TLS_PORTS.has(port);
  return { secure: implicit, requireTLS: !implicit };
}

export async function testImapLogin(input: ImapTestInput): Promise<void> {
  const target = await resolveAllowedMailHost(input.imapHost);

  const client = new ImapFlow({
    ...pinnedImapOptions(input.imapHost, target),
    port: input.imapPort,
    secure: tlsModeForPort(input.imapPort, input.security).secure,
    // imapflow upgrades only opportunistically by default: a server that stops
    // advertising STARTTLS would get the login in the clear. Demand the upgrade
    // exactly where requireTLS demands it for SMTP. Never `false`: in imapflow
    // that means "never upgrade", whereas undefined upgrades when offered —
    // the same opportunistic behaviour nodemailer has for security "none".
    doSTARTTLS: tlsModeForPort(input.imapPort, input.security).requireTLS ? true : undefined,
    auth: {
      user: input.username,
      pass: input.password,
    },
    logger: false,
    // Bound the probe so a firewalled/dead host can't hang the request for
    // imapflow's ~90s default. This is a user-facing "test connection" button.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  await client.connect();
  await client.logout();
}

export async function testSmtpVerify(input: ImapTestInput): Promise<void> {
  const target = await resolveAllowedMailHost(input.smtpHost);

  const { secure, requireTLS } = tlsModeForPort(input.smtpPort, input.security);
  const transport = nodemailer.createTransport({
    ...pinnedSmtpOptions(input.smtpHost, input.smtpPort, target, 10_000),
    port: input.smtpPort,
    secure,
    requireTLS,
    auth: {
      user: input.username,
      pass: input.password,
    },
    // Bound the probe so a dead SMTP host can't hang the request for
    // nodemailer's ~2min default.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.verify();
  } finally {
    transport.close?.();
  }
}
