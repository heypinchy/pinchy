import { z } from "zod";

/**
 * Opaque, client-supplied identifier for one chat within a (user, agent)
 * pair. It becomes the trailing segment of the OpenClaw session key
 * (`agent:<agentId>:direct:<userId>:<chatId>`), so it must stay free of the
 * `:` delimiter and other path/whitespace characters. Lowercase alphanumerics
 * and dashes only (nanoid-compatible), 1–64 chars.
 */
export const chatIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/);

/**
 * Body for `POST /api/agents/[agentId]/sessions/compact`.
 *
 * `maxLines` is optional — when omitted, OpenClaw uses its own default
 * compaction threshold. `chatId` (#508) scopes the compaction to one chat's
 * session; omitted → the default/legacy per-user session. Shared between the
 * route handler (parseRequestBody) and the client component (typed request
 * body via z.infer).
 */
export const compactSessionSchema = z.object({
  maxLines: z.number().int().positive().max(100_000).optional(),
  chatId: chatIdSchema.optional(),
});

export type CompactSessionRequest = z.infer<typeof compactSessionSchema>;

/**
 * One row in the response of `GET /api/agents/[agentId]/chats` — the user's
 * chats with an agent (#508). Shared between the route's response mapping and
 * the ChatSwitcher client component so the contract can't silently drift.
 *
 * - `chatId` is `null` for the legacy/default chat (the pre-#508 web session
 *   with no trailing chat segment).
 * - `origin` is where the chat happens: `web` (this app) or `telegram` (a
 *   linked Telegram peer, surfaced read-only).
 * - `writable` is `false` for Telegram chats; the web UI shows them read-only.
 * - `title` is the human-readable session label, or `null` when unset.
 * - `lastInteractionAt` is epoch milliseconds; the list is sorted by it
 *   (most recent first).
 */
export type ChatListItem = {
  chatId: string | null;
  sessionId: string;
  origin: "web" | "telegram";
  writable: boolean;
  title: string | null;
  lastInteractionAt: number;
};

/**
 * One message in the read-only Telegram transcript mirror returned by
 * `GET /api/agents/[agentId]/telegram-chat` (#508). Shared between the route's
 * response mapping and the read-only web view so the contract can't drift.
 *
 * This is a deliberately minimal projection of OpenClaw's history entry: the
 * web view mirrors the user's linked Telegram conversation read-only (no
 * posting), so it only needs who said what and when. Tool/system turns and
 * attachment-chip metadata that the live chat carries are dropped here.
 *
 * - `role` is `"user"` (the linked Telegram peer) or `"assistant"` (the agent).
 * - `text` is the rendered message text, with OpenClaw protocol markup removed.
 * - `timestamp` is epoch milliseconds, or `0` when OpenClaw omits it.
 */
export type TelegramTranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};
