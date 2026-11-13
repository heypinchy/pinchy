import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { pinnedSmtpOptions, resolveAllowedMailHost } from "@/lib/integrations/mail-host-guard";
import type { SystemMailConfig } from "@/lib/schemas/system-mail";

/**
 * The SMTP leg of the system mailer. nodemailer is imported lazily so an
 * install that never configures a mailer never loads it — the invite route
 * imports this module, and with the mailer off that route must behave exactly
 * as it did before #1309.
 *
 * Every connection goes through `resolveAllowedMailHost`: the host is
 * admin-supplied, and "does something answer SMTP on 10.0.0.5:25?" is the same
 * port-scanner question the IMAP probe guards against (#823), and the socket opens to the address that was checked,
 * not to a second lookup of the name (DNS rebinding). An on-premise
 * relay is legitimate and opts in through `ALLOW_PRIVATE_MAIL_HOSTS=1`.
 */

export type SystemMailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export function transportOptions(config: SystemMailConfig): SMTPTransport.Options {
  const tls =
    config.security === "tls"
      ? { secure: true, requireTLS: false }
      : config.security === "starttls"
        ? // requireTLS: a server that doesn't offer STARTTLS fails the send
          // instead of silently carrying the password in plaintext.
          { secure: false, requireTLS: true }
        : { secure: false, requireTLS: false };

  return {
    host: config.host,
    port: config.port,
    ...tls,
    ...(config.username ? { auth: { user: config.username, pass: config.password ?? "" } } : {}),
    // Bounded like the IMAP probe: the admin is waiting on the dialog, and
    // nodemailer's defaults would hold the request for about two minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

export function formatFrom(config: SystemMailConfig): { name: string; address: string } {
  return { name: config.fromName ?? "Pinchy", address: config.fromAddress };
}

async function openTransport(config: SystemMailConfig) {
  const target = await resolveAllowedMailHost(config.host);
  const nodemailer = (await import("nodemailer")).default;
  const options = transportOptions(config);
  return nodemailer.createTransport({
    ...options,
    // The hostname stays `host` (SNI, certificate); the socket is opened to
    // the checked addresses only, with fallback across them.
    ...pinnedSmtpOptions(config.host, config.port, target, options.connectionTimeout ?? 10_000),
  });
}

/** Connect, negotiate TLS and authenticate — without sending anything. */
export async function verifySystemMail(config: SystemMailConfig): Promise<void> {
  const transport = await openTransport(config);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendSystemMail(
  config: SystemMailConfig,
  message: SystemMailMessage
): Promise<void> {
  const transport = await openTransport(config);
  try {
    await transport.sendMail({
      from: formatFrom(config),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } finally {
    transport.close();
  }
}
