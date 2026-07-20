import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { connect as netConnect } from "node:net";
import type { ImapTestInput } from "@/lib/schemas/imap";

// Shared IMAP/SMTP probe logic used by BOTH:
//   - the pre-create "Test Connection" route (packages/web/src/app/api/integrations/imap/test/route.ts)
//   - the imap branch of probeIntegrationCredentials (packages/web/src/lib/integrations/probe.ts),
//     which re-probes an EXISTING connection's stored credentials.
// Kept in one place (DRY) so timeout bounds and error-message mapping never drift
// between the two callers.

// Maps low-level probe errors to short, friendly messages that never leak a
// stack trace or the password. Order matters: unambiguous network-error CODES
// are matched BEFORE the fuzzy "auth" wordlist, because that wordlist matches
// against the whole message — which includes the (user-controlled) hostname.
// A host named e.g. "smtp-auth.example.com" would otherwise turn a DNS/timeout/
// refused failure into a bogus "authentication failed".
export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

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
export type ProbeFailureCode = "timeout" | "refused" | "dns" | "auth" | "tls" | "unknown";

// Per-leg (IMAP or SMTP) outcome of a connection test — see ImapTestResult in
// @/lib/schemas/imap for how the two legs combine into the full API response.
export type LegResult = { ok: true } | { ok: false; code: ProbeFailureCode; message: string };

export function classifyProbeError(error: unknown): { code: ProbeFailureCode; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

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

function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: timeoutMs });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    // Keep the error listener attached for the socket's whole lifetime rather
    // than removing all listeners on the first settle: destroy() on a
    // still-connecting socket can emit a late 'error', and an 'error' event
    // with no listener crashes the process. The `settled` guard makes any such
    // late event a no-op instead of a second resolve.
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// SECURITY: this connects ONLY to the already-provided, caller-supplied
// smtpHost on a fixed, hardcoded port list — never to a host/port derived
// from user-controlled input beyond what the caller already validated and
// intended to probe. Do not widen this to accept arbitrary ports/hosts.
export async function probeSmtpPorts(
  host: string,
  ports: number[] = [465, 587, 25]
): Promise<SmtpPortProbe[]> {
  return Promise.all(
    ports.map(async (port) => ({
      port,
      reachable: await probeTcpPort(host, port, SMTP_PORT_PROBE_TIMEOUT_MS),
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
  const client = new ImapFlow({
    host: input.imapHost,
    port: input.imapPort,
    secure: tlsModeForPort(input.imapPort, input.security).secure,
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
  const { secure, requireTLS } = tlsModeForPort(input.smtpPort, input.security);
  const transport = nodemailer.createTransport({
    host: input.smtpHost,
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
