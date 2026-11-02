import { TOOL_REGISTRY } from "@/lib/tool-registry";
import { renderText, summarizeArgs, type SummarizeOptions } from "@/lib/approvals/summary";
import { displayScalar, inStoredOrderPlain } from "@/lib/approvals/display";

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

/** Cuts at a word boundary where one is near, so the text ends readably —
 * and never between the two halves of a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  const cut = text.slice(0, end);
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
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, v]) => `${key}: ${inline(v)}`)
      .join(", ")}}`;
  }
  // Every string is quoted, with its `"` and `\` escaped, so no string can
  // print as structure. Printed bare, `name: "Acme, active: false"` read
  // exactly like `name: "Acme", active: false`, and `ids: ["7, 8"]` like
  // `ids: [7, 8]` (fourteenth review of #1242). The card needs no quotes: it
  // draws each field and item in an element of its own. Line breaks stay
  // line breaks — everything else that could hide is a marker already — and
  // a key needs none either: it is a bare identifier or already quoted.
  if (typeof value === "string") return `"${value.replace(/["\\]/g, "\\$&")}"`;
  return displayScalar(value);
}

function describeArgs(params: unknown, options: SummarizeOptions): string {
  // Every argument is printed, `null` and empty ones included: leaving them
  // out would let `active: null` read the same as no `active` at all. And in
  // the order it was sent, as the card draws it: a chat client reorders
  // `/data/חוזים/2024.md` into `/data/2024/חוזים.md` exactly as a browser
  // does (eleventh review of #1242). That holds only where the client
  // implements Unicode's isolates (6.3+) and overrides; one that drops them
  // draws the text as before, and the card stays the view to decide on.
  return inStoredOrderPlain(
    Object.entries(summarizeArgs(params, options))
      .map(([key, value]) => `${key}: ${inline(value)}`)
      .join(", ")
  );
}

export function buildApprovalPrompt(
  toolName: string,
  params: unknown,
  /**
   * The resources the gate resolved this call to touch (#1133). Naming them is
   * not decoration: once deletion can be gated per model, "Delete a record in
   * Odoo" is not a decision anyone can make — an invoice and a note are the
   * whole reason the setting exists. `null` entries are resources we could not
   * name and are left unsaid rather than printed.
   */
  resources: (string | null)[] = [],
  /** The same ref resolver the card's summary uses, so a real record reference
   * reads as the record it names here too. */
  options: SummarizeOptions = {}
): { title: string; description: string } {
  const known = TOOL_REGISTRY.find((tool) => tool.id === toolName);

  // An unknown tool still gets a card, and the card still has to say something.
  // `knowledge_search` is the standing example: it is granted by the Knowledge
  // Base template and appears in no registry, which is exactly how #865's
  // confirmation list rendered empty.
  const action = known?.label ?? `Run ${toolName}`;
  // A model name comes from the call, so it is rendered like any other value:
  // a bidi override or a typed marker in it is shown, not obeyed.
  const named = [
    ...new Set(resources.filter((r): r is string => r !== null).map((r) => renderText(r))),
  ];
  const title = truncate(
    named.length > 0 ? `${action} — ${named.join(", ")}` : action,
    APPROVAL_TITLE_MAX
  );

  const args = describeArgs(params, options);
  const lead = known?.description ?? `The agent wants to run ${toolName}.`;
  const description = truncate(args ? `${lead} — ${args}` : lead, APPROVAL_DESCRIPTION_MAX);

  return { title, description };
}
