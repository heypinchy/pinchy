import { z } from "zod";

export const draftIdSchema = z.string().uuid();

export const attachmentIdsSchema = z
  .array(z.string().uuid())
  .max(10, "Too many attachments (max 10)");

export const uploadResponseSchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
