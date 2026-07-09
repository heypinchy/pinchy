import { z } from "zod";

// All fields optional — empty string means "leave current value unchanged".
// The submit handler filters out empty strings before sending the PATCH body.
export const odooEditSchema = z.object({
  url: z.string().optional(),
  db: z.string().optional(),
  login: z.string().optional(),
  apiKey: z.string().optional(),
});

export const webSearchEditSchema = z.object({
  apiKey: z.string().optional(),
});

// IMAP reconnect/edit form. All fields optional — empty means "leave current".
// Ports are coerced so the form can carry the prefilled masked string values.
export const imapEditSchema = z.object({
  imapHost: z.string().optional(),
  imapPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  security: z.enum(["tls", "starttls", "none"]).optional(),
  // From-header display name. Empty means "leave current" — same convention
  // as every other field here.
  senderName: z.string().max(200).optional(),
});
