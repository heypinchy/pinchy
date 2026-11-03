import { TOOL_REGISTRY } from "@/lib/tool-registry";
import { renderText, type CallSummary, type SummaryLimit } from "@/lib/approvals/summary";
import {
  displayScalar,
  inStoredOrderPlain,
  noteText,
  quoted,
  readNode,
  refText,
  secretText,
  textOf,
} from "@/lib/approvals/display";

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

/**
 * The most of one host a cut description names: its end, where the domain it
 * reaches is. A host has no length limit of its own, so a whole one could
 * take the description's place.
 */
export const PROMPT_HOST_MAX = 100;

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
 * It reads the summary the card draws (`summarizeCall`), never `params`
 * directly, and that is load-bearing: the approval prompt is delivered to
 * every connected approval surface — including chat channels — so it reaches
 * strictly more places than the in-app card does. Redacting less here than the card does
 * would mean the safer surface hides what the riskier one prints.
 */
function inline(value: unknown): string {
  // What Pinchy says about a value is printed OUTSIDE its quotes, so no quoted
  // text can imitate it: `partner_id: (record reference: res.partner #7 "Acme
  // GmbH")` is a ref, `partner_id: "(record reference: …)"` is a string
  // pinchy-odoo would look up by name.
  const node = readNode(value);
  if (node === "unreadable") return "(a value this version cannot show)";
  if (node?.["@"] === "ref") return refText(node);
  if (node?.["@"] === "secret") return secretText(node);
  if (node?.["@"] === "noted") {
    return [quoted(textOf(node.text)), ...node.notes.map((note) => `(${noteText(note)})`)].join(
      " "
    );
  }
  // The prompt prints every text whole; only the card previews one.
  if (node?.["@"] === "previewed") return quoted(node.text);
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, v]) => `${key}: ${inline(v)}`)
      .join(", ")}}`;
  }
  // Every string is quoted, with its `"` and `\` escaped, so no string can print
  // as structure. Printed bare, `name: "Acme, active: false"` would read exactly
  // like `name: "Acme", active: false`, and `ids: ["7, 8"]` like `ids: [7, 8]`. The
  // card needs no quotes: it draws each field and item in an element of its own.
  // Line breaks stay line breaks — everything else that could hide is a marker
  // already — and a key needs none either: it is a bare identifier or already
  // quoted.
  if (typeof value === "string") return quoted(value);
  return displayScalar(value);
}

function describeArgs(summary: Record<string, unknown>): string {
  // Every argument is printed, `null` and empty ones included: leaving them out
  // would let `active: null` read the same as no `active` at all. And in the
  // order it was sent, as the card draws it: a chat client reorders
  // `/data/חוזים/2024.md` into `/data/2024/חוזים.md` exactly as a browser does.
  // That holds only where the client implements Unicode's isolates (6.3+) and
  // overrides; one that drops them draws the text in the bidi algorithm's own
  // order, and the card stays the view to decide on.
  return inStoredOrderPlain(
    Object.entries(summary)
      .map(([key, value]) => `${key}: ${inline(value)}`)
      .join(", ")
  );
}

/**
 * Every host the call reaches, each once — `reaches "evil.com", "…aaaa.evil.org"
 * — `. A host longer than PROMPT_HOST_MAX is named by its end, where the
 * domain it reaches is. Empty when it reaches none.
 */
function reachesClause(hosts: string[]): string {
  const named = [...new Set(hosts)].map((host) =>
    quoted(host.length > PROMPT_HOST_MAX ? `…${host.slice(-PROMPT_HOST_MAX)}` : host)
  );
  return named.length > 0 ? `reaches ${named.join(", ")} — ` : "";
}

/** What a person reads before approving, on every approval surface. */
export interface ApprovalPrompt {
  title: string;
  description: string;
}

/**
 * The prompt for a call already summarized (`summarizeCall`). The gate builds
 * the card's summary and the prompt from one summary: summarizing a large call
 * costs real CPU on the server's one event loop, which every user shares.
 */
export function approvalPromptFor(
  toolName: string,
  call: Pick<CallSummary, "summary" | "hosts">,
  /**
   * The resources the gate resolved this call to touch (#1133). Naming them is
   * not decoration: once deletion can be gated per model, "Delete a record in
   * Odoo" is not a decision anyone can make — an invoice and a note are the
   * whole reason the setting exists. `null` entries are resources we could not
   * name and are left unsaid rather than printed.
   */
  resources: (string | null)[] = []
): ApprovalPrompt | { exceeded: SummaryLimit } {
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

  const { summary, hosts } = call;
  const args = describeArgs(summary);
  const lead = known?.description ?? `The agent wants to run ${toolName}.`;
  const whole = args ? `${lead} — ${args}` : lead;
  // A description that fits shows each address whole, with any note beside it.
  if (whole.length <= APPROVAL_DESCRIPTION_MAX) return { title, description: whole };

  // Cut, it can end anywhere — inside the address itself, past
  // `https://www.firma.at.` and before the domain it reaches, or in a long
  // text before it. So it names every host the call reaches first, and only
  // the arguments after them are cut. Every host, or no prompt: naming only
  // the hosts that fit would leave out whichever came last, and the order is
  // the call's to choose — decoys under `target` and `destination` ahead of a
  // fetch's `url` would take the room, and the host it reaches would go
  // unnamed. So a call whose hosts do not all fit is refused, like one too
  // large for the card (`describeRefusal`): split, each part names its own.
  const reaches = reachesClause(hosts);
  if (!reaches) return { title, description: truncate(whole, APPROVAL_DESCRIPTION_MAX) };
  const head = `${lead} — ${reaches}`;
  // At least one character after the hosts: the `…` that says the rest is cut.
  if (head.length >= APPROVAL_DESCRIPTION_MAX) {
    return { exceeded: { kind: "too-many-hosts", count: new Set(hosts).size } };
  }
  return { title, description: head + truncate(args, APPROVAL_DESCRIPTION_MAX - head.length) };
}
