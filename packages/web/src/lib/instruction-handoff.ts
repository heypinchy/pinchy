/**
 * Carries a drafted instruction from a chat message to the agent's Instructions
 * tab (#1144).
 *
 * A user and an agent work out a way of working during a conversation. The
 * agent can write its memory but not its own Instructions — deliberately — so
 * the rule ends up in the one store it can reach, where it is unreviewed and,
 * worse, absent from scheduled runs (OpenClaw serves those from a bootstrap set
 * that excludes MEMORY.md). "Save as instruction" is the handover: the agent
 * drafts, the person accepts, and the rule lands in the store that is versioned
 * and that every session reads.
 *
 * ## Why sessionStorage and not a query parameter
 *
 * The draft is free text out of a conversation. It can name a customer, a
 * price, an internal rule. A query string is written to browser history, sent
 * as a `Referer` to whatever the next page loads, and logged by every proxy in
 * between — none of which is an acceptable place for it. sessionStorage stays
 * in the tab, survives the one navigation this needs, and is cleared as soon as
 * it is read.
 *
 * It is keyed per agent so a draft prepared for one agent can never surface in
 * another's settings, and `take` is destructive for the same reason a stale
 * draft must not reappear the next time someone opens the tab for an unrelated
 * edit.
 */

const KEY_PREFIX = "pinchy:instruction-draft:";

function storageKey(agentId: string): string {
  return `${KEY_PREFIX}${agentId}`;
}

/**
 * sessionStorage throws rather than returning null in two real cases: Safari's
 * private mode (quota 0) and a browser configured to block storage. Neither is
 * a reason to break the chat, so every access here degrades to "no handoff" —
 * the user still has the text in front of them and can copy it.
 */
function safely<T>(fn: () => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Whether to offer "Save as instruction" on a message.
 *
 * Two conditions, and the first is the one that matters: the viewer must be
 * allowed to save. `canWriteAgent` is resolved server-side and handed down
 * through `CanEditAgentContext` rather than re-derived here — a menu item that
 * leads to a 403 is worse than one that isn't there. The second keeps the item
 * off a message with nothing to carry (a pure tool-call or image turn).
 */
export function canOfferInstructionHandoff(canEditAgent: boolean, messageText: string): boolean {
  return canEditAgent && messageText.trim().length > 0;
}

export function stashInstructionDraft(agentId: string, draft: string): boolean {
  const trimmed = draft.trim();
  if (!trimmed) return false;
  return safely(() => {
    window.sessionStorage.setItem(storageKey(agentId), trimmed);
    return true;
  }, false);
}

/** Reads the pending draft and removes it. Returns null when there is none. */
export function takeInstructionDraft(agentId: string): string | null {
  return safely(() => {
    const key = storageKey(agentId);
    const value = window.sessionStorage.getItem(key);
    if (value === null) return null;
    window.sessionStorage.removeItem(key);
    return value.trim() || null;
  }, null);
}

export function clearInstructionDraft(agentId: string): void {
  safely(() => {
    window.sessionStorage.removeItem(storageKey(agentId));
    return true;
  }, false);
}

/**
 * Appends a draft to the saved instructions.
 *
 * Append, never replace: what the agent drafted is one rule, and the file is
 * everything the agent was already told. Replacing would silently drop the rest
 * — and a refinement of an existing rule is a judgement about prose that
 * belongs to the person reading the diff, not to a merge routine.
 *
 * A blank separator line keeps two Markdown blocks from running together; empty
 * instructions get the draft on its own, with no leading blank line to delete.
 */
export function appendInstructionDraft(existing: string, draft: string): string {
  const base = existing.replace(/\s+$/, "");
  const addition = draft.trim();
  if (!addition) return existing;
  if (!base) return `${addition}\n`;
  return `${base}\n\n${addition}\n`;
}
