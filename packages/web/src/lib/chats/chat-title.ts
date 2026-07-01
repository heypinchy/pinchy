import type { ChatListItem } from "@/lib/schemas/sessions";

/**
 * Human-readable title for a chat row — the saved label when present, otherwise
 * a date-stamped fallback derived from the chat's last interaction. Shared by
 * the ChatSwitcher and the diagnostics-export picker so the fallback format
 * can't drift between the two lists.
 */
export function chatTitle(item: ChatListItem): string {
  if (item.title && item.title.trim().length > 0) return item.title;
  return `Chat from ${new Date(item.lastInteractionAt).toLocaleDateString()}`;
}
