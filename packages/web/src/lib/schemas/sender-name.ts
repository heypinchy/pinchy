import { z } from "zod";

// From-header display name for agent-sent mail ("Clemens Helm
// <clemens@example.com>"). NOT the integration label. CR/LF is rejected at
// the schema edge as the first header-injection barrier; the plugin adapter
// guards again at send/draft time (defense in depth).
//
// Shared by imapCreateSchema (imap.ts) and imapEditSchema
// (integration-edit.ts) so the guard can't drift between create and edit.
export const senderNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => !/[\r\n]/.test(v), {
    message: "Sender name must not contain line breaks",
  });
