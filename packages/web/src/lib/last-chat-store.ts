"use client";

/**
 * Per-device memory of the chat a user last had open for each agent (#508).
 *
 * Clicking an agent in the sidebar should return the user to the chat they were
 * last in on this device — not the oldest/default chat. We store the last-VIEWED
 * chat id (not last-interacted) in localStorage, keyed per agent, so the choice
 * is per-device by design: different devices can have different chats open.
 *
 * The default/legacy chat has no chatId; viewing it CLEARS the pointer rather
 * than storing a sentinel, so the sidebar falls back to the server-resolved
 * most-recently-interacted chat. The default chat has no distinct, non-redirecting
 * URL of its own, and if it is genuinely the user's most active chat the fallback
 * lands there anyway.
 */
const KEY_PREFIX = "pinchy:lastChat:";

// localStorage emits no same-tab change event (`storage` only fires in OTHER
// tabs), so a component reading this store via useSyncExternalStore — the sidebar
// (#508) — would never see a write made in its own tab. Its resolved agent link
// would then lag one render behind `recordLastChat` (which runs in a post-render
// effect) and reopen an OLDER chat. Keep an in-module listener set and notify it
// on every write so same-tab subscribers re-read immediately.
const listeners = new Set<() => void>();

/**
 * Subscribe to same-tab changes of the last-chat store. Returns an unsubscribe
 * function. Pair this with the cross-tab `storage` event in the consumer's
 * `useSyncExternalStore` subscribe so both same-tab and cross-tab writes refresh.
 */
export function subscribeLastChat(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordLastChat(agentId: string, chatId: string | null | undefined): void {
  if (typeof localStorage === "undefined") return;
  const key = KEY_PREFIX + agentId;
  if (chatId) {
    localStorage.setItem(key, chatId);
  } else {
    localStorage.removeItem(key);
  }
  for (const listener of listeners) listener();
}

export function getLastChat(agentId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY_PREFIX + agentId);
}
