import { z } from "zod";
import type { LegResult, SmtpPortProbe } from "@/lib/integrations/imap-probe";

export const imapTestSchema = z.object({
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().min(1).max(65535),
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
  security: z.enum(["tls", "starttls", "none"]),
});

export type ImapTestInput = z.infer<typeof imapTestSchema>;

export const imapCreateSchema = imapTestSchema.extend({
  // Optional label for the integrations list; the create route defaults it to
  // the mailbox address when omitted (rename is available in the list).
  name: z.string().min(1).optional(),
  // Optional display name for the From header of agent-sent mail
  // ("Clemens Helm <clemens@example.com>"). NOT the integration label. CR/LF
  // is rejected at the schema edge as the first header-injection barrier; the
  // plugin adapter guards again at send/draft time (defense in depth).
  senderName: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => !/[\r\n]/.test(v), {
      message: "Sender name must not contain line breaks",
    })
    .optional(),
});

export type ImapCreateInput = z.infer<typeof imapCreateSchema>;

// Structured response of POST /api/integrations/imap/test, shared by the
// route handler and the ImapConnectStep UI (typed client convention — see
// AGENTS.md "Shared Schemas And Typed Client"). Consumed directly, not
// zod-validated on the client: this is a server-authored diagnostic, not
// user input.
export type ImapTestSuggestion =
  | { kind: "switch_smtp_port"; port: number; security: "starttls" | "tls" }
  | { kind: "all_smtp_blocked" }
  | null;

export interface ImapTestResult {
  ok: boolean;
  imap: LegResult;
  smtp: LegResult;
  // Only present when the SMTP leg failed at the connection level (timeout or
  // refused) and we ran a raw-TCP reachability probe against the standard
  // SMTP ports to figure out why.
  smtpPortProbe?: SmtpPortProbe[];
  suggestion?: ImapTestSuggestion;
  // Primary friendly banner text when !ok — mirrors the IMAP/SMTP leg that
  // failed first (IMAP takes priority since it blocks reading mail at all).
  error?: string;
}
