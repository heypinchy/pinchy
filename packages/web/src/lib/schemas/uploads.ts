import { z } from "zod";

export const draftIdSchema = z.string().uuid();

/**
 * Maximum number of attachments per message — enforced server-side by
 * `attachmentIdsSchema` on the WS frame, and client-side by `addPendingUpload`
 * so users get an inline error before wasting upload bandwidth on the 11th
 * file. Keep both in sync: changing this constant updates both layers.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export const attachmentIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_ATTACHMENTS_PER_MESSAGE, `Too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`);

export const uploadResponseSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
