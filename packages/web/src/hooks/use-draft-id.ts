import { useState } from "react";

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
