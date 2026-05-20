import { z } from "zod";

export const diagnosticsExportRequestSchema = z.object({
  agentId: z.string().min(1),
  anchorMessageId: z.string().min(1).optional(),
  userDescription: z.string().max(500).optional(),
});

export type DiagnosticsExportRequest = z.infer<typeof diagnosticsExportRequestSchema>;
