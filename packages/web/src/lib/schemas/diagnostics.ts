import { z } from "zod";

export const diagnosticsExportRequestSchema = z.object({
  agentId: z.string().min(1),
  anchorMessageId: z.string().min(1).optional(),
  userDescription: z.string().max(500).optional(),
  /**
   * Opaque OpenClaw session id of the chat to export (from `ChatListItem`).
   * Unlike `chatId`, it uniquely identifies a chat even for Telegram peers and
   * the default chat (both carry `chatId: null`). The route re-authorizes it
   * against the user's own chats before reading anything. Omitted → today's
   * behaviour (the user's default chat). The charset guard is defense-in-depth
   * on top of the reader's `assertSafeSegment`: no `:` (session-key delimiter),
   * no path separators.
   */
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export type DiagnosticsExportRequest = z.infer<typeof diagnosticsExportRequestSchema>;
