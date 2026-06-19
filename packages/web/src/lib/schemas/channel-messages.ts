import { z } from "zod";

/**
 * Body for `POST /api/internal/channel-messages` — the capture endpoint the
 * `pinchy-transcript` OpenClaw plugin calls for every inbound/outbound channel
 * message. Gateway-token authed. The plugin is the only caller; this schema is
 * shared so the plugin's payload and the route's parser can never drift.
 *
 * Neither `agentId` nor `peerId` is in the body: BOTH are derived server-side
 * from `sessionKey` (`agent:<agentId>:direct:<peer>`), the single source of
 * truth — so a compromised/buggy plugin can't mis-attribute a message to an
 * arbitrary agent or peer by spoofing a field. The attribution is whatever the
 * session is keyed to, and it stays consistent with the read route (which
 * derives the peer from `channel_links`).
 */
export const captureChannelMessageSchema = z.object({
  /** Channel id from the hook, e.g. "telegram". */
  channel: z.string().trim().min(1),
  /** `agent:<agentId>:direct:<peer>` — agentId AND peer are parsed from this. */
  sessionKey: z.string().trim().min(1),
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
