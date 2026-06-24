import type { ClassifiedChat } from "@/lib/chats/classify-sessions";

/**
 * Pick the chat to open when a user clicks an agent and has no recorded
 * last-viewed chat on this device (#508) — the most-recently-interacted WEB chat.
 *
 * Returns its `chatId`, or `null` when the caller should render the default/legacy
 * chat instead. `null` is returned when there are no web chats, OR when the most
 * recent web chat IS the default chat (chatId null): the default chat has no
 * chatId to redirect to, and redirecting `/chat/<agentId>` back to itself would
 * loop. Telegram chats are read-only mirrors and never a landing target, so they
 * are excluded from the recency comparison.
 */
export function selectMostRecentWebChatId(classified: ClassifiedChat[]): string | null {
  const mostRecentWeb = classified
    .filter((c) => c.origin === "web")
    .reduce<ClassifiedChat | null>(
      (best, c) => (best === null || c.lastInteractionAt > best.lastInteractionAt ? c : best),
      null
    );
  return mostRecentWeb?.chatId ?? null;
}
