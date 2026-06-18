"use client";

import { useState } from "react";

/**
 * Returns a stable draft ID scoped to the given agent and chat (#508).
 *
 * The ID is generated once on first mount and persisted in localStorage so it
 * survives page reloads of the same composer. It is used as the `x-pinchy-draft-id`
 * header when POSTing to `/api/agents/<id>/uploads`, which stages uploads
 * server-side per draft id — so the id MUST be per-chat, otherwise a file
 * staged while composing in one chat would surface as a pending attachment in
 * a sibling chat of the same agent.
 *
 * The default/legacy chat (no chatId) keeps its original 4-segment storage key
 * for backward compatibility; a per-chat composer gets the chatId as an extra
 * segment. chatId is `[a-z0-9-]+`, so a chat key can never collide with the
 * default key (different segment count).
 *
 * IMPORTANT: `agentId`/`chatId` must be stable across re-renders. If the parent
 * changes them without unmounting, the hook keeps the original draft ID. Use a
 * `key` prop on the consumer to force remount when either changes.
 */
export function useDraftId(agentId: string, chatId?: string): string {
  const [draftId] = useState<string>(() => {
    const key = chatId
      ? `pinchy:composer:${agentId}:${chatId}:draftId`
      : `pinchy:composer:${agentId}:draftId`;
    const stored = localStorage.getItem(key);
    if (stored) {
      return stored;
    }
    const newId = crypto.randomUUID();
    localStorage.setItem(key, newId);
    return newId;
  });

  return draftId;
}
