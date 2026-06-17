import { mapTelegramTranscript, type RawHistoryMessage } from "@/lib/chats/telegram-transcript";

/** Max length of a derived chat title before we truncate and append an ellipsis. */
export const TITLE_MAX_LENGTH = 60;

/**
 * Derive a human-readable chat title from a session's OpenClaw history by taking
 * its first user message (#508). Returns `null` when there is no usable user
 * message, so callers can fall back to a date-stamped label.
 *
 * The normalization (drop tool/system turns, join array content, strip
 * OpenClaw's `[timestamp]` prefix and the `<pinchy:attachments>` block, drop
 * empties and queued-retry duplicates) is shared with the read-only Telegram
 * mirror via `mapTelegramTranscript` — so a chat's list title matches the first
 * line a user would actually read in the transcript, with no separate parser to
 * drift.
 */
export function firstUserMessageTitle(rawMessages: RawHistoryMessage[]): string | null {
  const firstUser = mapTelegramTranscript(rawMessages).find((m) => m.role === "user");
  if (!firstUser) return null;

  // mapTelegramTranscript already collapses internal whitespace runs only via
  // its joins; normalize newlines/tabs so a multi-line message reads as one line.
  const text = firstUser.text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;

  if (text.length <= TITLE_MAX_LENGTH) return text;
  return `${text.slice(0, TITLE_MAX_LENGTH).trimEnd()}…`;
}
