"use client";

import { useState } from "react";

/**
 * Returns a stable draft ID scoped to the given agent.
 *
 * The ID is generated once on first mount and persisted in localStorage so it
 * survives page reloads of the same composer. It is used as the `x-pinchy-draft-id`
 * header when POSTing to `/api/agents/<id>/uploads`.
 *
 * IMPORTANT: `agentId` must be stable across re-renders. If the parent changes
 * `agentId` without unmounting, the hook keeps the original draft ID. Use a
 * `key` prop on the consumer to force remount when `agentId` changes.
 */
export function useDraftId(agentId: string): string {
  const [draftId] = useState<string>(() => {
    const key = `pinchy:composer:${agentId}:draftId`;
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
