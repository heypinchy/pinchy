import { z } from "zod";
import { mailHostSchema } from "@/lib/schemas/imap";
import { senderNameSchema } from "@/lib/schemas/sender-name";

/**
 * Schemas for the system mailer (Settings → Organization → Email delivery,
 * #1309), shared by `/api/settings/mail` and the settings card so a payload
 * rename is a compile error (AGENTS.md § "Shared Schemas And Typed Client").
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
