/**
 * Constants for parsing OpenClaw's `chat.history` (a.k.a. `sessions.history`)
 * wire output. Centralised here so the live-chat parser (`client-router.ts`),
 * the read-only Telegram mirror (`chats/telegram-transcript.ts`), and their
 * tests all read from ONE source — an OpenClaw-side string change then can't
 * quietly diverge between production and its test fixtures.
 */

/**
 * Prefix OpenClaw stamps on a user message that arrived while another turn was
 * still active; such messages are duplicates of the original user turn already
 * in history and are filtered out before reaching the UI.
 */
export const QUEUED_RETRY_PREFIX =
  "[Queued user message that arrived while the previous turn was still active]";

/**
 * The literal OpenClaw substitutes for a message whose serialized size exceeds
 * its internal `CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES` cap (128 KB — an inline
 * image routinely trips this). The original content, and for a user turn the
 * embedded `<pinchy:attachments>` block, are discarded server-side. Verified
 * against real OpenClaw 2026.6.8 output.
 */
export const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";

/**
 * The friendly, user-facing text Pinchy shows in place of OpenClaw's raw
 * oversized placeholder so the user never sees the internal RPC string. Kept
 * non-empty so the message survives the content-or-files history filter
 * instead of being silently dropped.
 */
export const OVERSIZED_HISTORY_MESSAGE_TEXT = "This message was too large to reload from history.";
