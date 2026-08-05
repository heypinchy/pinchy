import { TOOL_REGISTRY } from "@/lib/tool-registry";
import { summarizeArgs } from "@/lib/approvals/summary";

/**
 * Builds the two strings a person reads before approving a tool call.
 *
 * #865 shipped the bare tool name, which names the function and not the act:
 * "odoo_create requires confirmation" tells the reviewer neither what will
 * happen nor to what. Approval-screen research is consistent on the three
 * things a reviewer needs — the action, the target, and the consequence — and
 * a function name carries none of them.
 *
 * The caps are OpenClaw's, and they are enforced rather than advisory: the
 * gateway rejects a `plugin.approval.request` whose title exceeds 80
 * characters, so an over-long string does not degrade the card, it fails the
 * tool call. The description limit is documented as 256 while the shipped
 * constant reads 512 (`PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH`, 2026.7.1-2);
 * we hold to the documented number, because that is the contract and the
 * looser constant is free to tighten back to it.
 */
export const APPROVAL_TITLE_MAX = 80;
export const APPROVAL_DESCRIPTION_MAX = 256;

/** Cuts at a word boundary where one is near, so the text ends readably. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * Renders the call's arguments as one readable clause.
 *
 * It goes through `summarizeArgs` rather than reading `params` directly, and
 * that is load-bearing: the approval prompt is delivered to every connected
 * approval surface — including chat channels — so it reaches strictly more
 * places than the in-app card does. Redacting less here than the card does
 * would mean the safer surface hides what the riskier one prints.
 */
function describeArgs(params: unknown): string {
  const summary = summarizeArgs(params);
  const parts = Object.entries(summary)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.join(", ");
}

export function buildApprovalPrompt(
  toolName: string,
  params: unknown
): { title: string; description: string } {
  const known = TOOL_REGISTRY.find((tool) => tool.id === toolName);

  // An unknown tool still gets a card, and the card still has to say something.
  // `knowledge_search` is the standing example: it is granted by the Knowledge
  // Base template and appears in no registry, which is exactly how #865's
  // confirmation list rendered empty.
  const title = truncate(known?.label ?? `Run ${toolName}`, APPROVAL_TITLE_MAX);

  const args = describeArgs(params);
  const lead = known?.description ?? `The agent wants to run ${toolName}.`;
  const description = truncate(args ? `${lead} — ${args}` : lead, APPROVAL_DESCRIPTION_MAX);

  return { title, description };
}
