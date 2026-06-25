export interface Draft {
  text: string;
  files: File[];
}

/**
 * In-memory layer: holds the full draft (text + File objects) for the lifetime of
 * the page. `File` objects are not serializable, so attachments live ONLY here and
 * are session-scoped — they survive in-app navigation but not a reload. That is an
 * acceptable limit: composer attachments are pre-upload local files, and no chat
 * product resurrects unsent file attachments across a reload.
 */
const drafts = new Map<string, Draft>();

/**
 * Durable layer: the draft TEXT is mirrored to localStorage so it survives a full
 * reload and a mobile tab eviction (the in-memory Map does not). Text is the part
 * users actually lose and ask to keep; the in-memory Map stays the authoritative
 * source within a session (it also carries the files), and localStorage is the
 * fallback consulted only when the Map has no entry (i.e. after a reload).
 */
const TEXT_PREFIX = "pinchy:composer:draft:";

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
  const inMemory = drafts.get(key);
  if (inMemory) return inMemory;
  // Map miss (e.g. immediately after a reload) — recover the persisted text.
  if (typeof localStorage === "undefined") return undefined;
  const text = localStorage.getItem(TEXT_PREFIX + key);
  return text ? { text, files: [] } : undefined;
}

export function saveDraft(key: string, draft: Draft): void {
  if (!draft.text && draft.files.length === 0) {
    clearDraft(key);
    return;
  }
  drafts.set(key, draft);
  if (typeof localStorage === "undefined") return;
  // Only text is durable; a files-only draft has nothing serializable to persist.
  if (draft.text) {
    localStorage.setItem(TEXT_PREFIX + key, draft.text);
  } else {
    localStorage.removeItem(TEXT_PREFIX + key);
  }
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(TEXT_PREFIX + key);
}
