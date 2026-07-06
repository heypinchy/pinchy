import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { ImapTestInput } from "@/lib/schemas/imap";

// Shared IMAP/SMTP probe logic used by BOTH:
//   - the pre-create "Test Connection" route (packages/web/src/app/api/integrations/imap/test/route.ts)
//   - the imap branch of probeIntegrationCredentials (packages/web/src/lib/integrations/probe.ts),
//     which re-probes an EXISTING connection's stored credentials.
// Kept in one place (DRY) so timeout bounds and error-message mapping never drift
// between the two callers.

// Maps low-level probe errors to short, friendly messages that never leak a
// stack trace or the password. Order matters: more specific patterns first.
export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("auth") ||
    lower.includes("invalid login") ||
    lower.includes("invalid credentials") ||
    lower.includes("535")
  ) {
    return "Authentication failed — check the username and password";
  }
  if (lower.includes("timed out") || lower.includes("timeout") || lower.includes("etimedout")) {
    return "Connection timed out — check the host and port";
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("ehostunreach") ||
    lower.includes("could not connect")
  ) {
    return "Could not connect to the server — check the host and port";
  }
  if (lower.includes("certificate") || lower.includes("self signed") || lower.includes("ssl")) {
    return "Could not establish a secure connection — check the security setting";
  }
  return "Connection failed — check your settings and try again";
}

export async function testImapLogin(input: ImapTestInput): Promise<void> {
  const client = new ImapFlow({
    host: input.imapHost,
    port: input.imapPort,
    secure: input.security === "tls",
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
  const transport = nodemailer.createTransport({
    host: input.smtpHost,
    port: input.smtpPort,
    secure: input.security === "tls",
    requireTLS: input.security === "starttls",
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
