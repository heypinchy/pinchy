/**
 * Turns the document paths a knowledge-base answer mentions into links to the
 * agent's workspace-file route, so a citation can be opened and checked.
 *
 * Why a remark plugin and not a post-processing pass over the rendered DOM:
 * the Sources list is written by the MODEL, and its shape is not stable. Within
 * one day, against one corpus, three shapes appeared — the template's bullet
 * list, the same model embellishing into a run-on paragraph, and another model
 * inventing `*Quelle: …, S. 275*` under each section. Working on the mdast means
 * one implementation covers bullets, paragraphs and table cells alike, because
 * it keys off the path itself rather than the format around it.
 *
 * The transform is deliberately additive: text it does not recognise is left
 * exactly as it was. The fallback is therefore today's behaviour (plain text),
 * so a model that invents a fourth shape costs a link, never a broken answer.
 *
 * Authorization is unaffected. The href points at
 * `/api/agents/[agentId]/workspace-file`, which resolves the request against the
 * SAME `allowed_paths` that scope retrieval, re-checks the session, and audits
 * the view. A fabricated path in an answer therefore yields a link that 403s —
 * it cannot widen what the user may read.
 */

/**
 * An absolute path ending in an extension we can serve. The extension is baked
 * into the pattern rather than checked separately: a second predicate deciding
 * the same thing is a pair that drifts, and a mutation test proved the separate
 * check was already unreachable. Widening what is linkable therefore means
 * editing this alternation — today only `.pdf`, which is also the only type the
 * ingest accepts and the only one the route renders inline.
 *
 * Anchoring on the extension is what keeps arbitrary path-shaped strings
 * (`/etc/passwd`) out. The lookahead trims trailing sentence punctuation, so
 * "…/doc.pdf." links the file and not the full stop. Paths in a real corpus
 * routinely contain spaces ("PF LAB/…"), so segments allow them.
 */
const SOURCE_PATH = /\/(?:[^\s/]|[^\s/][^/]*?[^\s/])?(?:\/[^/\n]+?)*?\.pdf(?=[\s,.;:)\]]|$)/gi;

/** `p. 44`, `S. 275`, `page 12`, `Seite 3` — the page hint that may follow a path. */
const TRAILING_PAGE = /^\s*[—–\-,]?\s*(?:p\.?|pp\.?|page|s\.|seite)\s*(\d{1,5})\b/i;

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

/**
 * Builds the href for one cited document. The path is carried as a query
 * parameter (not a path segment) because it is absolute and may contain any
 * character a filesystem allows; `#page=N` is the fragment Chrome's and
 * Firefox's built-in PDF viewers both honour, and it is inert for anything else.
 */
export function buildSourceHref(agentId: string, path: string, page: number | null): string {
  const base = `/api/agents/${encodeURIComponent(agentId)}/workspace-file?path=${encodeURIComponent(path)}`;
  return page === null ? base : `${base}#page=${page}`;
}

/** The marker that identifies an href this module produced. Exported so the renderer recognises its own links without re-deriving the shape. */
export const WORKSPACE_FILE_MARKER = "/workspace-file?path=";

/**
 * Recovers the document path from an href built by `buildSourceHref`, for use
 * as the viewer's title. Returns null for anything else, which is how the
 * renderer tells a citation from an ordinary link. Kept beside the builder so
 * the two cannot drift — a dialog whose accessible name silently came back
 * empty would be a real defect for a screen-reader user, and string surgery on
 * a url is exactly the kind of code that decays quietly.
 */
export function parseSourceHref(href: string): { path: string; page: number | null } | null {
  const markerIndex = href.indexOf(WORKSPACE_FILE_MARKER);
  if (markerIndex === -1) return null;

  const afterMarker = href.slice(markerIndex + WORKSPACE_FILE_MARKER.length);
  const [encodedPath, fragment] = afterMarker.split("#");
  if (!encodedPath) return null;

  const pageMatch = /^page=(\d{1,5})$/.exec(fragment ?? "");
  try {
    return { path: decodeURIComponent(encodedPath), page: pageMatch ? Number(pageMatch[1]) : null };
  } catch {
    // A malformed percent-escape must not take down the render of a whole message.
    return null;
  }
}

/**
 * Splits one text node into text/link/text… parts. Returns null when nothing
 * matched, which lets the caller leave the original node untouched rather than
 * replace it with an equivalent copy.
 */
function linkifyText(value: string, agentId: string): MdastNode[] | null {
  const parts: MdastNode[] = [];
  let cursor = 0;
  SOURCE_PATH.lastIndex = 0;

  for (let match = SOURCE_PATH.exec(value); match !== null; match = SOURCE_PATH.exec(value)) {
    const path = match[0];

    // A page number may trail the path ("— p. 44"). It is consumed into the
    // href but left in the visible text: the reader still sees which page is
    // being cited, and the link merely opens there.
    const pageMatch = TRAILING_PAGE.exec(value.slice(match.index + path.length));
    const page = pageMatch ? Number(pageMatch[1]) : null;

    if (match.index > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    parts.push({
      type: "link",
      url: buildSourceHref(agentId, path, page),
      children: [{ type: "text", value: path }],
    });
    cursor = match.index + path.length;
  }

  if (parts.length === 0) return null;
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

/**
 * remark plugin factory. `agentId` scopes every generated href to the agent
 * whose answer this is — the route rejects anything outside that agent's
 * granted folders, so the id must come from the rendering context and never
 * from the answer text.
 */
export function remarkSourceLinks({ agentId }: { agentId: string }) {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      // `link` is skipped so we never nest an anchor inside an anchor; `code`
      // and `inlineCode` because a path shown as code is being displayed, not
      // referenced. Neither carries text children we should rewrite.
      if (node.type === "link" || node.type === "code" || node.type === "inlineCode") return;
      if (!node.children) return;

      const rewritten: MdastNode[] = [];
      let changed = false;
      for (const child of node.children) {
        if (child.type === "text" && child.value) {
          const parts = linkifyText(child.value, agentId);
          if (parts) {
            rewritten.push(...parts);
            changed = true;
            continue;
          }
        }
        visit(child);
        rewritten.push(child);
      }
      if (changed) node.children = rewritten;
    };

    visit(tree);
  };
}
