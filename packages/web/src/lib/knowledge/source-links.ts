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
import { fromCitationPath, toCitationPath } from "./citation-path";

/**
 * A DATA-ROOT-RELATIVE path ending in an extension we can serve, anchored at the
 * END of the slice it is run against — see `findSourcePaths` for why it is never
 * let loose on a whole text node. The extension is baked into the pattern rather
 * than checked separately: a second predicate deciding the same thing is a pair
 * that drifts, and a mutation test proved the separate check was already
 * unreachable. Widening what is linkable therefore means editing this
 * alternation — today only `.pdf`, which is also the only type the ingest
 * accepts and the only one the route renders inline.
 *
 * Relative, with NO leading slash, because that is the shape `knowledge_search`
 * shows the model and a model can only cite what it is shown (#933). The
 * absolute form is rebuilt in `buildSourceHref` via `fromCitationPath`, the one
 * place that knows the data root.
 *
 * At least one `/` is required. A bare `report.pdf` is exactly the citation
 * shape a full path exists to prevent — unfindable in a deep tree, ambiguous
 * across folders — and linking it would dress that failure up as a working
 * reference. Anchoring on the extension is what keeps arbitrary path-shaped
 * strings (`/etc/passwd`) out.
 *
 * Paths in a real corpus routinely contain spaces ("PF LAB/…"), so segments
 * allow them — except the FIRST one, which must be a whitespace-delimited
 * token. That asymmetry replaces the leading `/` the absolute form used to be
 * pinned by: without something marking where a path may begin, the leftmost
 * match happily swallows the prose in front of it and links "[1] a/one.pdf"
 * rather than "a/one.pdf". A mount name with a space in it is the price, and
 * "the citation starts at a word" is a rule a reader can predict.
 */
const SOURCE_PATH_ENDING_HERE = /[^\s/]+(?:\/[^/\n]+?)+?\.pdf$/i;

/** What may follow a path so that "…/doc.pdf." links the file and not the full stop. */
const PATH_BOUNDARY = /[\s,.;:)\]]/;

/**
 * Locates the extension case-insensitively. A plain `indexOf` on a lowercased
 * copy would be the obvious way and is wrong: case folding is not
 * length-preserving ("İ".toLowerCase() is two characters), so every offset
 * after such a character shifts and the path is extracted one character short.
 * Matching on the ORIGINAL string keeps offsets meaning what they say.
 */
const EXTENSION = /\.pdf/gi;

/**
 * How far back from an extension a path may reasonably start. The longest path
 * in the corpus this was built against is under 120 characters; 256 is slack,
 * not a fit. A path longer than this is read from its last 256 characters, so
 * the worst case is a link that opens a shorter path (and 403s) rather than a
 * scan that grows with the message.
 */
const MAX_PATH_LENGTH = 256;

/**
 * Finds the cited paths in one text node, left to right, non-overlapping.
 *
 * The obvious implementation — one global regex over the whole string — is what
 * this replaces, and the reason is not style. The pattern's nested lazy
 * quantifiers backtrack catastrophically on text that is path-SHAPED but never
 * completes a match (`/a/a/a/…/bbbb`, or an extension the boundary check
 * rejects): 18 KB of it took nearly seven seconds. This transform runs
 * synchronously in the browser on every streamed chunk of every message, so
 * that is a frozen chat, and the text is model output about documents a
 * knowledge base ingested — not something we get to assume is benign.
 *
 * So the scan is driven by the ONE landmark a citation must contain: the
 * extension. Each occurrence is found with `indexOf` (linear, no backtracking),
 * and only then is the regex run — anchored, over at most `MAX_PATH_LENGTH`
 * characters ending exactly there. Total work is bounded by
 * occurrences × constant instead of growing with the text.
 */
function findSourcePaths(value: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  EXTENSION.lastIndex = 0;
  for (let hit = EXTENSION.exec(value); hit !== null; hit = EXTENSION.exec(value)) {
    const end = hit.index + hit[0].length;

    // The character AFTER the extension, read from the real text rather than
    // the window below, so a path at the very end of the node is still a path.
    if (end < value.length && !PATH_BOUNDARY.test(value[end])) continue;

    const windowStart = Math.max(cursor, end - MAX_PATH_LENGTH);
    const match = SOURCE_PATH_ENDING_HERE.exec(value.slice(windowStart, end));
    if (!match) continue;

    found.push({ start: windowStart + match.index, end });
    cursor = end;
  }

  return found;
}

/** `p. 44`, `S. 275`, `page 12`, `Seite 3` — the page hint that may follow a path. */
const TRAILING_PAGE = /^\s*[—–\-,]?\s*(?:p\.?|pp\.?|page|s\.|seite)\s*(\d{1,5})\b/i;

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

/**
 * Builds the href for one cited document from the citation path the answer
 * shows. The route opens a file, so the href carries the ABSOLUTE path — the
 * conversion is `fromCitationPath`, which also confines the result to the data
 * root, since `citationPath` reaches here from model output.
 *
 * The path is carried as a query parameter (not a path segment) because it is
 * absolute and may contain any character a filesystem allows; `#page=N` is the
 * fragment Chrome's and Firefox's built-in PDF viewers both honour, and it is
 * inert for anything else.
 */
export function buildSourceHref(
  agentId: string,
  citationPath: string,
  page: number | null
): string {
  const absolutePath = fromCitationPath(citationPath);
  const base = `/api/agents/${encodeURIComponent(agentId)}/workspace-file?path=${encodeURIComponent(absolutePath)}`;
  return page === null ? base : `${base}#page=${page}`;
}

/**
 * The shape of an href this module produced, anchored at the START of the
 * string. The anchor is the security-relevant part.
 *
 * Recognising a citation by a substring search let ANY absolute url carrying
 * `/workspace-file?path=` through — `https://evil.example/workspace-file?path=…`
 * included. What the renderer recognises it hands to `<embed src>`, so that is
 * an arbitrary cross-origin frame inside the chat, reachable from model output
 * about documents the knowledge base ingested. There is no CSP to stop it
 * downstream. A citation is a same-origin path under `/api/agents/`, and the
 * only thing that can assert "same origin" is a leading `/` with no second one.
 *
 * Exported so the renderer recognises its own links without re-deriving the shape.
 */
export const WORKSPACE_FILE_HREF = /^\/api\/agents\/[^/]+\/workspace-file\?path=([^#]*)(?:#(.*))?$/;

/**
 * Recovers the CITATION path from an href built by `buildSourceHref`, for use
 * as the viewer's title. Citation and not absolute: this value is what the
 * reader sees above the document, and `/data/noack/…` there would put the
 * container path straight back in front of them (#933). Returns null for
 * anything else, which is how the renderer tells a citation from an ordinary
 * link. Kept beside the builder so the two cannot drift — a dialog whose
 * accessible name silently came back empty would be a real defect for a
 * screen-reader user, and string surgery on a url is exactly the kind of code
 * that decays quietly.
 */
export function parseSourceHref(href: string): { path: string; page: number | null } | null {
  const match = WORKSPACE_FILE_HREF.exec(href);
  if (!match) return null;

  const [, encodedPath, fragment] = match;
  if (!encodedPath) return null;

  const pageMatch = /^page=(\d{1,5})$/.exec(fragment ?? "");
  try {
    return {
      path: toCitationPath(decodeURIComponent(encodedPath)),
      page: pageMatch ? Number(pageMatch[1]) : null,
    };
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
  const matches = findSourcePaths(value);
  if (matches.length === 0) return null;

  const parts: MdastNode[] = [];
  let cursor = 0;

  for (const { start, end } of matches) {
    const path = value.slice(start, end);

    // A page number may trail the path ("— p. 44"). It is consumed into the
    // href but left in the visible text: the reader still sees which page is
    // being cited, and the link merely opens there.
    const pageMatch = TRAILING_PAGE.exec(value.slice(end));
    const page = pageMatch ? Number(pageMatch[1]) : null;

    if (start > cursor) parts.push({ type: "text", value: value.slice(cursor, start) });
    parts.push({
      type: "link",
      url: buildSourceHref(agentId, path, page),
      children: [{ type: "text", value: path }],
    });
    cursor = end;
  }

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
