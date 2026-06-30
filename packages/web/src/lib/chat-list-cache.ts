import type { ChatListItem } from "@/lib/schemas/sessions";

/**
 * Module-level per-agent chat-list cache (#610).
 *
 * `ChatSwitcher` refetches `/api/agents/[agentId]/chats` on every mount, so
 * switching agents shows an empty/"Loading your chats…" dropdown briefly each
 * time — even for an agent whose list was just loaded a moment ago. This cache
 * lets the switcher seed its initial state from the last successful list and
 * revalidate in the background (SWR-style): the dropdown is never empty on
 * re-open, and the existing re-fetch on dropdown-open / run-completion stays
 * the source of truth.
 *
 * The cache holds a shallow copy of the list so callers can't mutate the
 * cached entries in place. It is per-agent (keyed by `agentId`) and lives for
 * the lifetime of the page (a navigation that reloads the bundle clears it,
 * which is fine — the first open then behaves as before).
 */

const cache = new Map<string, ChatListItem[]>();

/** Whether a cached list for this agent is available (so the UI can skip the loading state). */
export function hasChatList(agentId: string): boolean {
  return cache.has(agentId);
}

/** Returns a shallow copy of the cached list, or `undefined` if none is stored. */
export function getChatList(agentId: string): ChatListItem[] | undefined {
  const cached = cache.get(agentId);
  return cached ? [...cached] : undefined;
}

/** Stores a shallow copy of the list for this agent. */
export function setChatList(agentId: string, chats: ChatListItem[]): void {
  cache.set(agentId, [...chats]);
}

/** Test-only: clear the cache between unit tests so they don't leak across each other. */
export function __resetChatListCacheForTests(): void {
  cache.clear();
}
