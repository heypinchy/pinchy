import { z } from "zod";

/**
 * Body for dismissing a durable chat-session error (the "paused" banner).
 * The id ties the dismiss to the exact row the banner is showing, so a race
 * with a freshly-recorded error can't dismiss the wrong one.
 */
export const dismissChatErrorSchema = z.object({
  id: z.string().min(1, "Error id is required"),
});

export type DismissChatErrorBody = z.infer<typeof dismissChatErrorSchema>;
