import { z } from "zod";

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
  name: z.string().min(1),
});

export type ImapCreateInput = z.infer<typeof imapCreateSchema>;
