export interface Draft {
  text: string;
  files: File[];
}

const drafts = new Map<string, Draft>();

export function getDraft(agentId: string): Draft | undefined {
  return drafts.get(agentId);
}

export function saveDraft(agentId: string, draft: Draft): void {
  if (!draft.text && draft.files.length === 0) {
    drafts.delete(agentId);
    return;
  }
  drafts.set(agentId, draft);
}

export function clearDraft(agentId: string): void {
  drafts.delete(agentId);
}
