import { z } from "zod";
import { mailHostSchema } from "@/lib/schemas/imap";
import { senderNameSchema } from "@/lib/schemas/sender-name";

/**
 * Schemas for the system mailer (Settings → Organization → Email delivery,
 * #1309), shared by `/api/settings/mail` and the settings card so a payload
 * rename is a compile error (agent-rules/web-routes.md § "Shared Schemas And Typed Client").
 *
 * Client-safe: neither import reaches the database or nodemailer.
 */

export const SYSTEM_MAIL_SECURITY = ["tls", "starttls", "none"] as const;
export type SystemMailSecurity = (typeof SYSTEM_MAIL_SECURITY)[number];

/** An empty string from a cleared input means "not set". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

/**
 * The stored configuration, and the `PUT /api/settings/mail` body. On `PUT`
 * an omitted `password` keeps the stored one (see `mergeWithStoredPassword`),
 * so the form never has to send a secret back that it never received.
 */
export const systemMailConfigSchema = z.object({
  host: mailHostSchema.transform((v) => v.trim()),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(SYSTEM_MAIL_SECURITY),
  // Absent username → no AUTH: internal relays that accept by IP exist.
  username: optionalText(320),
  // Not trimmed: a password may legitimately start or end with a space.
  password: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v ? v : undefined)),
  fromAddress: z.string().trim().pipe(z.email("Enter a valid sender address")),
  fromName: senderNameSchema.optional().or(z.literal("").transform(() => undefined)),
});
export type SystemMailConfigInput = z.input<typeof systemMailConfigSchema>;
export type SystemMailConfig = z.output<typeof systemMailConfigSchema>;

/** `GET /api/settings/mail` — never carries the password. */
export type SystemMailStatus =
  | { configured: false }
  | {
      configured: true;
      config: Omit<SystemMailConfig, "password"> & { hasPassword: boolean };
    };

/** `POST /api/settings/mail/test` takes no fields. */
export const systemMailTestSchema = z.object({}).strict();
export type SystemMailTestInput = z.infer<typeof systemMailTestSchema>;

/**
 * The outcome of an email Pinchy tried to send on an admin's behalf. Absent
 * from a response when no email was asked for.
 */
export type EmailDelivery = { sent: true } | { sent: false; error: string };

/** The default port, and the encryption each common port implies. */
export const DEFAULT_SMTP_PORT = 587;
export function securityForPort(port: number): SystemMailSecurity {
  return port === 465 ? "tls" : "starttls";
}

type PasswordRuleConfig = { host: string; port: number; security: SystemMailSecurity };

type StoredPasswordConfig = PasswordRuleConfig & { password?: string; hasPassword?: boolean };
type PasswordUpdate = PasswordRuleConfig & { username?: string; password?: string };

function hasStoredPassword(stored: StoredPasswordConfig | null): stored is StoredPasswordConfig {
  return Boolean(stored && (stored.hasPassword ?? Boolean(stored.password)));
}

/** Host names are case-insensitive; the port must match exactly. */
function sameServerAndPort(a: PasswordRuleConfig, b: PasswordRuleConfig): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

/**
 * Does an update that sends no password keep the stored one? Only while there
 * is a username to log in with and the host and port are the ones the password
 * was typed for. Shared by the route and the settings form so they agree.
 */
export function keepsStoredPassword<U extends PasswordUpdate>(
  update: U,
  stored: StoredPasswordConfig | null
): boolean {
  return Boolean(
    update.username &&
    !update.password &&
    hasStoredPassword(stored) &&
    sameServerAndPort(update, stored)
  );
}

/**
 * Must the admin type the password again? The saved one is never reused for a
 * different host or port, and never on a weaker connection of the same server;
 * sending nothing in those cases would only fail at AUTH with an empty
 * password. The rule lives here, not in `config.ts` (which imports the
 * database), so the settings form and the route read the same one.
 *
 * Only `security: "none"` is weaker. STARTTLS sets `requireTLS` on every port,
 * port 25 included, so the login never travels in the clear there. That does
 * not make 587/STARTTLS to 25/STARTTLS keep the password, though: the port
 * differs, so the password is asked for again on that account alone.
 */
export function needsPasswordReentry<U extends PasswordUpdate>(
  update: U,
  stored: StoredPasswordConfig | null
): boolean {
  if (!update.username || update.password || !hasStoredPassword(stored)) return false;
  return (
    !sameServerAndPort(update, stored) || (update.security === "none" && stored.security !== "none")
  );
}
