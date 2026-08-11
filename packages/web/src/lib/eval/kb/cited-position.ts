/**
 * Splits a Sources entry into the document it names and the position inside it.
 *
 * A Sources bullet is `<path> <position>`, and until #982 this file's job was
 * done by a single regex (`PAGE_SUFFIX`) that knew one position shape: `— p.
 * 12`. Two things were wrong with that, and the second is the one that bites.
 *
 * **Only pages.** Since #933 the anchor is a `ChunkLocator`, and a page is what
 * only a PDF has. A slide is `slide 4`, a Word section is `§ Quality > Incoming
 * goods`, a spreadsheet range is `Suppliers, rows 5-12`. None of those matched,
 * so the whole line fell into `entry.path` — and a correct citation graded as a
 * fabricated one is the worst kind of grader defect, because it reads as a
 * model failure.
 *
 * **And the wrong separator.** The dash form is what the OLD contract taught.
 * `pinchy-knowledge/index.ts` renders a hit as `` `[1] quality-file.md (p. 1):
 * "…"` `` — the position in PARENTHESES — and the contract asks the model to
 * repeat the path and position "exactly as written above". So the shape a
 * well-behaved answer really carries never matched at all. Both are parsed now.
 *
 * ── What this deliberately will NOT split ─────────────────────────────────
 * `[1] a/study.pdf – AOAC Performance Tested Method Study` is a path followed
 * by an embellishing title, and `gradePathCitation` fails it today on evidence
 * committed in `packages/web/eval/data`. Widening the split to "any dash-space
 * separator" would consume that title as a position and move a published
 * number. So this parser recognises the position SHAPES `formatLocator` emits
 * and nothing else — `cited-position.test.ts` round-trips every one of them
 * through `formatLocator`, and a fifth `ChunkLocator` kind fails that pin
 * rather than silently arriving unparsed.
 */
import type { ChunkLocator } from "../../knowledge/locator";

/** What a Sources entry names: the document, and where in it. */
export interface CitedPosition {
  /** The entry with its position suffix removed, trimmed. */
  path: string;
  /** The parsed position, or null when the entry carries none this parser knows. */
  locator: ChunkLocator | null;
}

/**
 * The position shapes, each anchored to the END of the string it is given.
 *
 * Three of the four open with a literal no path fragment can produce (`p.`,
 * `slide`, `§`), which is what lets them accept a plain hyphen as the
 * separator without `handbook-2012/policy.md` splitting at its own hyphen —
 * exactly the guarantee `PAGE_SUFFIX`'s required `p.` gave.
 *
 * `sheet` is the exception and is treated as one: a sheet name is free text, so
 * there is no literal at the boundary to prove a hyphen separates rather than
 * belongs to the path. It is accepted behind an em or en dash, and inside
 * parentheses where the delimiter is unambiguous. Behind a plain hyphen the
 * entry stays whole, which costs little: `matchRetrievedDocument` scans the
 * whole entry and resolves the document either way.
 */
const POSITION_SHAPES: {
  pattern: RegExp;
  /** Whether a plain `-` may introduce it (see above). */
  plainHyphen: boolean;
  /** Receives the SHAPE's own capture groups — the wrapper's path group is stripped first. */
  build: (groups: (string | undefined)[]) => ChunkLocator;
}[] = [
  {
    pattern: /pp?\.?\s*(\d+)(?:\s*[-–]\s*\d+)?/,
    plainHyphen: true,
    // The FIRST page of a range is the anchor, as `PAGE_SUFFIX` has always
    // stored it: a citation spanning pages 12-14 points the reader at 12.
    build: (g) => ({ kind: "page", page: Number.parseInt(g[0] ?? "", 10) }),
  },
  {
    pattern: /slide\s*(\d+)/,
    plainHyphen: true,
    build: (g) => ({ kind: "slide", slide: Number.parseInt(g[0] ?? "", 10) }),
  },
  {
    pattern: /§\s*(\S.*?)/,
    plainHyphen: true,
    build: (g) => ({
      kind: "heading",
      headings: (g[0] ?? "").split(">").map((heading) => heading.trim()),
    }),
  },
  {
    pattern: /(\S.*?),\s*rows?\s*(\d+)(?:\s*[-–]\s*(\d+))?/,
    plainHyphen: false,
    build: (g) => ({
      kind: "sheet",
      sheet: (g[0] ?? "").trim(),
      startRow: Number.parseInt(g[1] ?? "", 10),
      // `formatLocator` collapses a one-row range to "row 5"; parsing it back
      // has to restore both ends, or the round-trip pin would need a special
      // case and the two would be free to drift where it looks away.
      endRow: Number.parseInt(g[2] ?? g[1] ?? "", 10),
    }),
  },
];

/** `<path> (<position>)` — what the knowledge tool prints and the contract asks for back. */
function parenthesised(shape: RegExp): RegExp {
  return new RegExp(`^(.*?)\\s*\\(\\s*${shape.source}\\s*\\)\\s*$`, "i");
}

/** `<path> — <position>` — the shape the older contract taught, still written by models. */
function dashed(shape: RegExp, plainHyphen: boolean): RegExp {
  return new RegExp(`^(.*?)\\s*[—–${plainHyphen ? "-" : ""}]\\s*${shape.source}\\s*$`, "i");
}

/**
 * Reads the position off the end of a Sources entry.
 *
 * Returns the entry unchanged with a null locator when it carries no position
 * this parser recognises — which is a legitimate, if degraded, shape and not an
 * error. Shapes are tried in `POSITION_SHAPES` order; they are mutually
 * exclusive by their opening literal, except `sheet`, which is last because its
 * leading group is free text and would otherwise swallow the others.
 */
export function parseCitedPosition(entry: string): CitedPosition {
  for (const { pattern, plainHyphen, build } of POSITION_SHAPES) {
    for (const wrapped of [parenthesised(pattern), dashed(pattern, plainHyphen)]) {
      const match = wrapped.exec(entry);
      // Group 1 is the wrapper's path; everything after it belongs to the shape.
      if (match) return { path: match[1].trim(), locator: build(match.slice(2)) };
    }
  }
  return { path: entry.trim(), locator: null };
}
