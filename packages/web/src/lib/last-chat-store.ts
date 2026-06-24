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

export function recordLastChat(agentId: string, chatId: string | null | undefined): void {
  if (typeof localStorage === "undefined") return;
  const key = KEY_PREFIX + agentId;
  if (chatId) {
    localStorage.setItem(key, chatId);
  } else {
    localStorage.removeItem(key);
  }
}

export function getLastChat(agentId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY_PREFIX + agentId);
}
