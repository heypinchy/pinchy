import { z } from "zod";

/**
 * Body for `POST /api/internal/channel-messages` — the capture endpoint the
 * `pinchy-transcript` OpenClaw plugin calls for every inbound/outbound channel
 * message. Gateway-token authed. The plugin is the only caller; this schema is
 * shared so the plugin's payload and the route's parser can never drift.
 *
 * `agentId` is intentionally NOT in the body: it is derived server-side from
 * `sessionKey` (the single source of truth, matching the audit endpoint), so a
 * compromised/buggy plugin can't mis-attribute a message to an arbitrary agent
 * by spoofing an agentId field — the agent is whatever the session is keyed to.
 */
export const captureChannelMessageSchema = z.object({
  /** Channel id from the hook, e.g. "telegram". */
  channel: z.string().trim().min(1),
  /** `agent:<agentId>:direct:<peer>` — agentId is parsed from this. */
  sessionKey: z.string().trim().min(1),
  /** Channel-side user id (e.g. the Telegram peer). Lowercased on store. */
  peerId: z.string().trim().min(1),
  /** "inbound" = user→agent, "outbound" = agent→user. */
  direction: z.enum(["inbound", "outbound"]),
  /** Channel message id, or a deterministic surrogate. The idempotency key. */
  externalId: z.string().trim().min(1),
  /** Message text. Empty/whitespace-only messages are not captured. */
  content: z.string().min(1),
  /** Epoch milliseconds the message was sent on the channel. */
  sentAt: z.number().int().nonnegative(),
});

export type CaptureChannelMessage = z.infer<typeof captureChannelMessageSchema>;
