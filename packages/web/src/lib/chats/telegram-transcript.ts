import { parseAttachmentBlock } from "@/server/attachment-pipeline";
import type { TelegramTranscriptMessage } from "@/lib/schemas/sessions";
// Shared with client-router.ts and their tests — see @/lib/openclaw-history.
import { QUEUED_RETRY_PREFIX } from "@/lib/openclaw-history";

/**
 * One raw entry from OpenClaw's `sessions.history` wire output. `content` is
 * either a plain string or an array of content parts; we treat it as `unknown`
 * and narrow defensively, mirroring `HistoryMessage` in `client-router.ts`.
 */
export type RawHistoryMessage = {
  role: string;
  content?: unknown;
  timestamp?: number;
};

/**
 * Extract the rendered text from one OpenClaw history entry: join the text
 * parts of an array `content`, or use a string `content` as-is. Identical to
 * the extraction in `ClientRouter.handleHistory` so the read-only Telegram
 * mirror renders the same text the live chat would.
 */
function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter(
        (part: { type?: string; text?: string } | null | undefined): part is { text: string } =>
          part != null &&
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.length > 0
      )
      .map((part) => part.text)
      .join(" ");
  }
  return typeof content === "string" ? content : "";
}

/**
 * Map OpenClaw `sessions.history` entries to the minimal, read-only transcript
 * shape used by the Telegram chat mirror (#508).
 *
 * This reuses the exact normalization the live web chat applies in
 * `ClientRouter.handleHistory`:
 *   - keep only `user` / `assistant` turns (drop tool/system noise),
 *   - join array `content` text parts (or use string content),
 *   - strip `<final>` protocol tags from assistant text,
 *   - strip OpenClaw's `[timestamp]` prefix from user messages and lift out the
 *     `<pinchy:attachments>` block via `parseAttachmentBlock`,
 *   - drop messages that are empty after stripping,
 *   - drop queued-retry duplicates.
 *
 * Unlike the live chat it does NOT surface attachment `files` chips — the
 * mirror is a static read-only text view — so an attachment-only user message
 * (no prose) collapses to empty and is dropped, which is acceptable for a
 * read-only mirror.
 */
export function mapTelegramTranscript(
  rawMessages: RawHistoryMessage[]
): TelegramTranscriptMessage[] {
  return rawMessages
    .filter((msg) => msg.role === "user" || msg.role === "assistant")
    .map((msg) => {
      let text = extractText(msg.content);

      // Strip protocol tags from assistant responses.
      text = text.replace(/<\/?final>/g, "");

      if (msg.role === "user") {
        // Strip OpenClaw's timestamp prefix, then lift out the attachment block.
        text = text.replace(/^\[.*?\]\s*/, "");
        text = parseAttachmentBlock(text).cleanText;
      }

      return {
        role: msg.role as "user" | "assistant",
        text,
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp : 0,
      };
    })
    .filter((msg) => msg.text.length > 0)
    .filter((msg) => !(msg.role === "user" && msg.text.startsWith(QUEUED_RETRY_PREFIX)));
}
