import type { DispatchableEmail, EmailWorkflowFilter } from "@/lib/email-workflows/types";

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * Deterministic gate the dispatcher runs before claiming an email (design §6):
 * no LLM, no I/O. Semantics — AND across fields, OR within an array field, all
 * string comparisons case-insensitive. An unset or empty field imposes no
 * constraint (so a workflow with `subjectContains: []` never silently drops all
 * mail); an empty filter matches every email.
 */
export function matchesFilter(email: DispatchableEmail, filter: EmailWorkflowFilter): boolean {
  const { from, toDomain, subjectContains, hasAttachment, attachmentType, folder } = filter;

  if (from?.length) {
    const sender = email.from.toLowerCase();
    if (!from.some((f) => f.toLowerCase() === sender)) return false;
  }

  if (toDomain?.length) {
    const wanted = toDomain.map((d) => d.toLowerCase());
    const recipientDomains = email.to.map(domainOf);
    if (!recipientDomains.some((d) => wanted.includes(d))) return false;
  }

  if (subjectContains?.length) {
    const subject = email.subject.toLowerCase();
    if (!subjectContains.some((s) => subject.includes(s.toLowerCase()))) return false;
  }

  if (hasAttachment !== undefined && email.attachments.length > 0 !== hasAttachment) {
    return false;
  }

  if (attachmentType) {
    const wanted = attachmentType.toLowerCase();
    if (!email.attachments.some((a) => a.contentType.toLowerCase() === wanted)) return false;
  }

  if (folder && email.folder?.toLowerCase() !== folder.toLowerCase()) {
    return false;
  }

  return true;
}
