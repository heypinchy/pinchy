import type { ChatListItem } from "@/lib/schemas/sessions";
import { apiGet } from "@/lib/api-client";

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
const inFlight = new Set<string>();

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

/**
 * Warms the cache for an agent (SWR-style prefetch). Deduplicated: a no-op when
 * the cache is already warm or a request for this agent is already in flight.
 * Fire-and-forget for callers; returns a promise so tests can await it. Fetch
 * failures degrade silently, leaving the cache untouched — the switcher's own
 * fetch on mount stays the source of truth.
 */
export function prefetchChatList(agentId: string): Promise<void> {
  if (cache.has(agentId) || inFlight.has(agentId)) return Promise.resolve();
  inFlight.add(agentId);
  return apiGet<{ chats: ChatListItem[] }>(`/api/agents/${agentId}/chats`)
    .then((res) => {
      setChatList(agentId, res.chats ?? []);
    })
    .catch(() => {
      // Silent — a cold cache just means the next open behaves as before.
    })
    .finally(() => {
      inFlight.delete(agentId);
    });
}

/**
 * Drops the cached list for an agent so the next read refetches. Dock point for
 * a future chat delete/rename that must not show a stale list.
 */
export function invalidateChatList(agentId: string): void {
  cache.delete(agentId);
}

/** Test-only: clear the cache between unit tests so they don't leak across each other. */
export function __resetChatListCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
