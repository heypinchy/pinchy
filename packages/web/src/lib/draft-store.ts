export interface Draft {
  text: string;
  files: File[];
}

const drafts = new Map<string, Draft>();

/**
 * Store key for one composer draft, scoped to a single (agent, chat) pair (#508).
 *
 * A draft belongs to ONE chat, never to the agent as a whole — otherwise a draft
 * typed in one chat surfaces in a sibling chat of the same agent (the cross-session
 * bleed bug). When `chatId` is omitted the key is the bare `agentId`, byte-identical
 * to the pre-per-chat key, so the default/legacy chat keeps its existing entry.
 *
 * Mirrors `chatSessionKey` in chat-session-provider.tsx (same `(agent, chat)` →
 * key shape); kept local so the draft store stays a standalone, dependency-free lib.
 */
export function draftKey(agentId: string, chatId?: string | null): string {
  return chatId ? `${agentId}:${chatId}` : agentId;
}

export function getDraft(key: string): Draft | undefined {
  return drafts.get(key);
}

export function saveDraft(key: string, draft: Draft): void {
  if (!draft.text && draft.files.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, draft);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}
