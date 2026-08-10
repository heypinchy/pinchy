/**
 * Pure attribution graders for the KB eval harness's Layer 2 gate (KB Eval
 * Harness plan, Task 2.1). These grade the ANSWER TEXT a model produced, not
 * retrieval quality (that's Layer 1, `retrieval-eval.ts`) or groundedness
 * (Layer 3, later). Every grader is a pure function over an `AttributionInput`
 * — no I/O, no DB — so they are trivially unit-testable with hand-built
 * fixtures, mirroring the invoice eval's `graders.ts`.
 *
 * These graders encode the citation-integrity rules taught in
 * `agent-templates/data/knowledge-base.ts` and enforce the four live
 * 2026-07-16 regressions captured in
 * `src/__tests__/lib/agent-templates/knowledge-base.test.ts`:
 *   - Block-A: the answer cited only [1] inline, but the Sources list ALSO
 *     carried "[2] Quality File 2012_4.pdf — p. 169" — a chunk
 *     `knowledge_search` returned but the answer never used. A
 *     listed-but-uncited source makes a single-source claim look
 *     independently corroborated (`source-uncited`).
 *   - Block-E: the answer cited "[1][4]" inline, but the Sources list held
 *     only [1], [2], [5], [8] — [4] was unresolvable, a dead end for the
 *     reader (`citation-unresolved`).
 *   - The bare-filename regression: Block-A's own uncited entry
 *     ("Quality File 2012_4.pdf") is also an example of citing a bare
 *     filename instead of the full path `knowledge_search` handed the model —
 *     unfindable in a deep corpus and ambiguous across same-named files in
 *     different folders (`path-not-cited`).
 *   - The run-on Sources list bug: the answer is rendered as markdown, so a
 *     Sources list not written as one `- [N] ...` bullet per line collapses
 *     into an unreadable single paragraph (`sources-format`).
 *
 * `gradeNoDuplicateCorroboration` is carried over from the retrieval layer
 * (Task 1.5's reframe — see `retrieval-eval.ts`'s `nearDuplicateSourcePaths`
 * doc comment): retrieval legitimately returns near-duplicate passages from
 * different paths (per-path `allowed_paths` access control requires it), so
 * the "don't let a reworded duplicate look like independent corroboration"
 * concern belongs here, on what the model actually CITES, not on what
 * retrieval returns.
 */
import { toCitationPath } from "@/lib/knowledge/citation-path";

import { matchRetrievedDocument } from "./cited-path-match";

import type { KbFailureTag, KbGraderResult } from "./types";

/** A source `knowledge_search` returned for the query this answer responds to. */
export interface RetrievedSource {
  // `n` and `page` mirror the real `knowledge_search` result shape the harness
  // feeds in (each returned chunk carries its 1-based citation number and
  // page). Only `sourcePath` is read by the current graders; `n` and `page`
  // are kept for a future page-mismatch grader (does the Sources entry's cited
  // page match the page the tool actually returned for that number?).
  /** 1-based citation number as presented to the model (the [N]). */
  n: number;
  sourcePath: string;
  page: number | null;
}

export interface AttributionInput {
  /** The model's full visible answer text: inline [N] markers + trailing Sources list. */
  answer: string;
  /** The sources knowledge_search returned for this answer (full paths). */
  retrieved: RetrievedSource[];
  /**
   * Known near-duplicate path groups (each group = paths sharing a passage).
   * Supplied by the harness (deterministic in the self-test). Empty by default.
   */
  nearDuplicateGroups?: string[][];
}

/** One parsed `- [N] <path> — p. <page>` line from the Sources list. */
interface SourcesEntry {
  n: number;
  path: string;
  page: number | null;
  /** Offset of the entry's line start within `sourcesText` — read by `gradeSourcesFormat`. */
  index: number;
  /** Whether markdown renders this line as a list item (so it starts a line of its own). */
  isListItem: boolean;
  /** Whether the number came from an explicit `[N]` rather than the ordered-list position. */
  hasMarker: boolean;
}

/**
 * Locates the trailing "Sources:" heading the template teaches (`**Sources:**`
 * on its own line, preceded by a blank line), optionally markdown-bolded
 * and/or hash-headinged. LINE-START anchored (`^` with the `m` flag) so the
 * heading must begin its line: a "Sources:" embedded mid-sentence
 * ("Based on my Sources: the policy requires review [1]." / "See Sources: the
 * wiki and the handbook [1].") is NOT at a line start and does not match, so
 * it can never mis-split the answer. `parseAnswer` takes the LAST match, so a
 * legitimate mid-prose mention BEFORE the real trailing list does not
 * mis-split the body — an earlier first-match parse truncated the body at
 * "Based on my ", swallowed the real inline `[1]` into the Sources region, and
 * emitted false `source-uncited` + `sources-format` failures on a well-formed
 * answer. Because these graders also run against real Layer-3 model output, a
 * false positive corrupts the scorecard.
 *
 * The two colon-less shapes match with a LOOKAHEAD for the line end rather
 * than consuming it, and that is not cosmetic. `**Sources**` is very often
 * followed by two spaces — a markdown hard break, and the only thing making the
 * first entry render on a line of its own. Consuming them moved the break into
 * the heading match, so `gradeSourcesFormat` looked at a bare `\n`, judged the
 * entry to be running into the heading, and charged five of `gpt-oss:120b`'s
 * runs for a separator that was there all along.
 *
 * Deliberately NOT `$`-anchored (heading alone on its line): the real
 * run-on-paragraph bug puts the whole list on the SAME line as the heading
 * ("**Sources:** [1] ... [4] ..."), and a `$` anchor would make that shape
 * fail to match at all — the answer would be treated as having no Sources
 * list and `gradeSourcesFormat` (whose entire job is catching that run-on)
 * would silently pass it. Line-START anchoring is the exact discriminator we
 * want: the run-on heading begins its line (matches, list captured, run-on
 * caught) while an embedded mid-prose "Sources:" does not (no match, no
 * phantom list).
 *
 * `[^\S\r\n]` rather than `[ \t]` throughout — horizontal whitespace of any
 * kind, but never a line break. `gpt-oss:120b` separates a marker from its path
 * with U+202F (narrow no-break space), which JS counts as `\s`: the parser
 * skipped the marker, then refused the line for beginning with whitespace, and
 * the entry disappeared. Same lesson as the fullwidth brackets — these models do
 * not type ASCII punctuation, and a separator is structure, not identity.
 *
 * Deliberately case-SENSITIVE on "Sources" (capital S) — the template always
 * capitalizes it, and matching case-insensitively would trip on ordinary
 * prose like "according to our sources: the policy states...". Uses spaces/tabs
 * (`[ \t]`, not `\s`) between tokens so it never spans a line break.
 *
 * Accepts all plausible Layer-3 model formattings of the heading, requiring a
 * colon so a bare "Sources" line of prose is not a heading:
 *   - plain `Sources:`
 *   - `**Sources:**` (colon INSIDE the bold — what the template teaches)
 *   - `**Sources**:` (colon OUTSIDE the bold — an equally plausible choice a
 *     model makes; without this alternation the heading went unrecognized and
 *     every inline `[N]` became a spurious `citation-unresolved`)
 *   - `### Sources:` (hash heading)
 * The `(?::[ \t]*\*{0,2}|\*{0,2}[ \t]*:)` alternation is the colon-inside vs.
 * colon-outside split; a leading `\*{0,2}` supplies the opening bold for both.
 *
 * Two colon-LESS shapes are accepted as well, and neither is a guess — they
 * are the two the first real Layer-3 sweep (#869) actually produced:
 *   - `**Sources**` — bold on both sides, nothing else on the line. 22 of 33
 *     graded answers wrote this, including 10 of kimi-k2.6's 12 and 10 of
 *     gpt-oss:120b's 12. Each lost its entire Sources list, and each was then
 *     charged with `citation-unresolved` AND `ungrounded-claim` — the latter
 *     on answers quoting the retrieved passage word for word.
 *   - `### Sources` — hash-prefixed, nothing else on the line. Replaying those
 *     33 answers through the bold widening alone leaves 6 unrecognized: 5 wrote
 *     no Sources heading at all, and exactly 1 wrote this.
 *
 * The colon requirement had a real reason: prose like "according to our
 * sources:" must not read as a heading. That reason covers a BARE word, and
 * neither of these is bare — a line delimited by `**` on both sides, or opened
 * by `#`, cannot be the start of a sentence. Requiring the line to END there
 * (`$`) is what tells them apart from "Sources of funding are listed below".
 * A colon also renders no differently from no colon, so the rule was measuring
 * the parser rather than the model.
 */
const SOURCES_HEADING =
  /^[^\S\r\n]*(?:#{0,3}[^\S\r\n]*\*{0,2}[^\S\r\n]*(?:Sources|Quellen?)[^\S\r\n]*(?::[^\S\r\n]*\*{0,2}|\*{0,2}[^\S\r\n]*:)|\*{2}[^\S\r\n]*(?:Sources|Quellen?)[^\S\r\n]*\*{2}(?=[^\S\r\n]*$)|#{1,3}[^\S\r\n]*(?:Sources|Quellen?)(?=[^\S\r\n]*$))/gm;

/** Any `[N]` marker, inline citation or Sources-bullet citation number alike. */
const INLINE_CITATION = /\[(\d+)\]/g;

/**
 * Bracket forms a model substitutes for `[` and `]` around a citation number.
 *
 * `gpt-oss:120b` does not write ASCII punctuation. Across the 2026-08-04 sweep
 * it used U+3010/U+3011 for brackets, U+2011 for `-`, U+2013 for `–` and
 * U+201C for `"` — consistently, not occasionally. Eight of its twelve runs
 * therefore had no inline citation `INLINE_CITATION` could see, so
 * `citedNumbers` was empty: every Sources entry read as listed-but-uncited, the
 * premise set came back empty, and `ungrounded-claim` followed on answers that
 * quote the retrieved passage word for word. Its 0/12 measured Unicode.
 *
 * Only the two bracket pairs, and only around the marker. U+FF3B/U+FF3D are by
 * definition the fullwidth forms of `[`/`]`; U+3010/U+3011 is what the sweep
 * actually produced. Nothing else is guessed at — a variant nobody has written
 * would be speculation, and this list is cheap to extend when one shows up.
 */
const MARKER_BRACKETS: [RegExp, string][] = [
  [/[【［]/g, "["],
  [/[】］]/g, "]"],
];

/**
 * Two further marker spellings, normalised AFTER the brackets are ASCII so each
 * is written once rather than twice.
 *
 * - `[1†quality-file.md (undefined)]` — `gpt-oss:120b`'s labelled marker, the
 *   OpenAI citation form. The number is there; a document label rides behind a
 *   dagger. `INLINE_CITATION` wants the bracket to close after the digits, so it
 *   saw no citation at all.
 * - `[3, 4]` — `glm-5.2` groups consecutive citations into one bracket. Read
 *   literally that is not a number, so both citations vanished.
 *
 * Both were invisible while the Sources parser was equally blind, and both
 * surfaced the moment it was not: a body whose citations cannot be seen against
 * a list that now parses reads as a list nothing cites, so every entry would
 * have been charged `source-uncited` — "a retrieved-but-unused chunk presented
 * as if it independently corroborates the answer", said of an answer that cited
 * every one of them. Widening one side alone would have traded an artefact for
 * a worse-worded artefact.
 *
 * The label is DISCARDED rather than read. It is the model's gloss of the
 * document, not the Sources entry, and `path-not-cited` grades what the entry
 * names — resolving a citation through an inline label would let a body-side
 * mention stand in for a list a model never wrote.
 */
const MARKER_LABEL = /\[(\d+)†[^\]\n]*\]/g;
const MARKER_GROUP = /\[(\d+(?:[ \t]*,[ \t]*\d+)+)\]/g;

/**
 * The answer with citation-marker brackets in ASCII, and NOTHING else touched.
 *
 * The line this draws is the whole point, so it is worth stating twice:
 * normalise what identifies STRUCTURE, never what identifies a DOCUMENT. A
 * marker is a delimiter — the reader pairs `…per day【1】` with `[1] policy.md`
 * without help, and nothing in the product parses inline markers at all
 * (`source-links.ts` keys off the path). A PATH is identity: `retention‑correct
 * .md` with U+2011 is not the path `knowledge_search` showed, `source-links.ts`
 * will not linkify it, and a reader who clicks gets nothing — so `path-not-
 * cited` is right to charge it and this function must not sand that off.
 *
 * The product already draws the same line: `TRAILING_PAGE` in `source-links.ts`
 * accepts `—`, `–` and `-` alike for the page suffix while requiring the path
 * to match exactly, and `PAGE_SUFFIX` below follows it.
 *
 * Module-private on purpose: every export in this file names the consumer it
 * exists for, and this one has none — `parseAnswer` is its only caller, and the
 * behaviour is asserted through the public graders that read its output.
 */
function normalizeCitationMarkers(answer: string): string {
  let normalized = answer;
  for (const [pattern, replacement] of MARKER_BRACKETS) {
    normalized = normalized.replace(pattern, replacement);
  }
  normalized = normalized.replace(MARKER_LABEL, "[$1]");
  return normalized.replace(MARKER_GROUP, (_match, numbers: string) =>
    numbers
      .split(",")
      .map((n) => `[${n.trim()}]`)
      .join("")
  );
}

/**
 * One line of a Sources list, in every shape the first real sweep wrote.
 *
 * An entry is a line that OPENS with a citation number, in one of two
 * spellings — an explicit `[N]` marker, or an ordered-list ordinal (`3.`) whose
 * position IS the number the reader pairs an inline `[3]` with. Either may be
 * preceded by a list marker (`-`, `*`, or the ordinal itself), and the two may
 * co-occur (`1. [1] onboarding-part2.md`).
 *
 * The predecessor of this regex required a `-`/`*` bullet AND a leading `[N]`,
 * which is the taught shape and nothing else. Measured against the 2026-08-05
 * sweep, 20 of 48 runs were charged `citation-unresolved` and NOT ONE of them
 * cited a source it had not listed: every one had written its list as plain
 * `[N]` lines or as an ordered list, parsed to zero entries, and so had every
 * inline marker read as a dead end. A grader that reports a citation-integrity
 * failure on a list naming exactly the right documents is measuring which
 * bullet character the model happened to pick.
 *
 * What is deliberately still NOT an entry: a line carrying neither spelling.
 * A trailing "All sources retrieved on 2026-08-05." would otherwise become an
 * entry that no inline marker cites (`source-uncited`) and that the
 * groundedness premise lookup would try to resolve to a document.
 *
 * Three capture groups, in this order — the package targets below ES2018, so
 * NAMED groups are a compile error here (`tsc` says so; vitest transpiles them
 * happily, which is exactly the gap `pnpm typecheck` exists to close):
 *   1. the ordinal (`3.` form), 2. the marker (`[3]` form), 3. the rest of the
 * line, which `PAGE_SUFFIX` and `matchRetrievedDocument` read.
 *
 * When both numbers are present the MARKER wins — `1. [3] c.md` is the reader's
 * [3], and a model that renumbers its list while keeping the tool's markers
 * must not have its citations silently reassigned by position.
 */
const SOURCES_ENTRY_LINE =
  /^[^\S\r\n]*(?:(\d+)[.)][^\S\r\n]+|[-*][^\S\r\n]+)?(?:\[(\d+)\][^\S\r\n]*)?(\S.*)$/gm;

/**
 * Just the opening of a Sources line — list marker and/or `[N]`, nothing of the
 * path. Matches the empty string on a line that has neither, which is what the
 * buried-marker scan below wants: on a plain paragraph line, everything counts
 * as "after the head".
 */
const SOURCES_ENTRY_HEAD = /^[^\S\r\n]*(?:\d+[.)][^\S\r\n]+|[-*][^\S\r\n]+)?(?:\[\d+\][^\S\r\n]*)?/;

/** True for a Sources line that markdown renders as its own list item. */
const LIST_ITEM_PREFIX = /^[^\S\r\n]*(?:[-*][^\S\r\n]+|\d+[.)][^\S\r\n]+)/;

/**
 * A citation marker that is NOT the head of its line and still has text after
 * it on that line — i.e. a marker introducing a source mid-paragraph, which is
 * the run-on shape: "**Sources:** [1] a.md — p. 1 [2] b.md — p. 2".
 *
 * The trailing-text condition is what separates a buried entry from a trailing
 * ANNOTATION. `glm-5.2` writes "1. handbook-2012/policy.md — passage [1]",
 * where the marker closes the line rather than opening a source; that list
 * renders as cleanly as any other, and charging it would repeat the mistake
 * this rewrite is undoing one shape further in.
 */
const BURIED_MARKER = /\[\d+\][^\S\r\n]*\S/;

/**
 * A separation that survives markdown rendering, at the END of the text
 * preceding an entry: a blank line (new paragraph) or a hard break (two or more
 * trailing spaces, or a backslash, before the newline). A lone `\n` is NOT one
 * — markdown joins those lines into a single paragraph, which is the run-on the
 * `sources-format` axis exists to catch.
 */
const RENDERED_SEPARATION = /(?:\n[^\S\r\n]*\n|(?:[ \t]{2,}|\\)\n)[^\S\r\n]*$/;

/**
 * Trailing page suffix on a Sources entry's rest-of-line text — separates the
 * PATH (group 1) from the page reference (group 2). Non-greedy path capture so
 * a hyphen inside the path itself (e.g. "/data/handbook-2012/policy.md") is not
 * mistaken for the dash separator — the required "p."/"pp." literal after the
 * dash disambiguates. Accepts a single page (`— p. 12`), a page range
 * (`— p. 12-14`), and the `pp.` plural (`— pp. 12-14`). A Sources entry with no
 * page suffix at all (a legitimate, if degraded, shape) leaves `pageMatch`
 * null and parses with `page: null` — the point of widening this is to keep a
 * range from folding into `entry.path` and spuriously failing the exact
 * path-match in `gradePathCitation`. `page` stores the FIRST page number
 * (`parseInt` of the range) — it is not asserted downstream yet.
 *
 * The SEPARATOR takes em dash, en dash and hyphen alike, for the same reason
 * the markers above take fullwidth brackets: it delimits, it does not identify.
 * `gpt-oss:120b` writes U+2013 where the template writes `—`, and an
 * unrecognised separator leaves `– p. 1` glued to `entry.path` — where the
 * whole-entry matcher in `cited-path-match.ts` still resolves the document, but
 * `gradeNoDuplicateCorroboration`, which compares `entry.path` by string
 * equality against its near-duplicate groups, silently stops matching. The
 * product's own `TRAILING_PAGE` (`source-links.ts`) already accepts all three.
 *
 * Only pages, deliberately, and only correct while only pages exist. Since
 * #933 the anchor is a `ChunkLocator` and the contract asks for a POSITION:
 * `slide 4`, `§ Quality > Incoming goods`, `Suppliers, rows 5-12`. None of
 * those match here, so the whole line would fall into `entry.path` and grade a
 * correct citation as a fabricated one. Nothing writes a non-page locator yet
 * (xlsx-extract is not wired into the ingest, the Office path produces pages),
 * so this cannot fire today — but the producer that changes that must
 * generalise this parser in the same change. #982 has the trap and the reason
 * a naive "split on any dash" fix would move committed eval numbers.
 */
const PAGE_SUFFIX = /^(.*?)\s*[—–-]\s*pp?\.?\s*(\d+(?:\s*[-–]\s*\d+)?)\s*$/i;

interface ParsedAnswer {
  /** Raw text BEFORE the Sources heading (or the whole answer if there is none). */
  body: string;
  /** Distinct inline-cited numbers found in the answer BODY (before the Sources heading). */
  citedNumbers: Set<number>;
  /** Parsed Sources-list bullets, in document order. */
  entries: SourcesEntry[];
  /** Whether a "Sources:" heading was found at all. */
  hasSourcesList: boolean;
  /** Raw text after the heading (used by `gradeSourcesFormat` for the run-on check). */
  sourcesText: string;
}

function parseSourcesEntries(sourcesText: string): SourcesEntry[] {
  const entries: SourcesEntry[] = [];
  for (const match of sourcesText.matchAll(SOURCES_ENTRY_LINE)) {
    const [, ordinal, marker, restRaw] = match;
    // A line that opens with neither spelling of a number is not an entry.
    if (marker === undefined && ordinal === undefined) continue;
    const n = Number(marker ?? ordinal);
    const rest = (restRaw ?? "").trim();
    if (rest.length === 0) continue;
    const pageMatch = PAGE_SUFFIX.exec(rest);
    entries.push({
      n,
      path: pageMatch ? pageMatch[1].trim() : rest,
      page: pageMatch ? Number.parseInt(pageMatch[2], 10) : null,
      index: match.index,
      isListItem: LIST_ITEM_PREFIX.test(match[0]),
      hasMarker: marker !== undefined,
    });
  }
  return entries;
}

/** Splits `answer` into its cited-body and Sources-list halves and parses both. */
function parseAnswer(answer: string): ParsedAnswer {
  // Marker brackets in ASCII before anything is located or counted, so every
  // reader below — the heading split, `citedNumbers`, `BULLET_LINE`,
  // `gradeSourcesFormat`'s two counts — sees one spelling. Applied to the whole
  // answer rather than per-region because the split itself depends on it: a
  // body whose citations are invisible is what made a Sources list read as
  // entirely uncited. Path text is untouched by construction — the replacement
  // is two bracket pairs, and no path in this corpus contains one.
  const text = normalizeCitationMarkers(answer);

  // Take the LAST line-start heading match: the real Sources list is always
  // the trailing block, so an earlier mid-prose "Sources:" mention never wins
  // the split. `matchAll` (not `.exec`) avoids the stateful-`lastIndex`
  // footgun of a `g`-flagged regex.
  const headingMatches = [...text.matchAll(SOURCES_HEADING)];
  const headingMatch = headingMatches.at(-1) ?? null;
  const hasSourcesList = headingMatch !== null;
  const headingIndex = headingMatch?.index ?? 0;
  const body = hasSourcesList ? text.slice(0, headingIndex) : text;
  const sourcesText = hasSourcesList ? text.slice(headingIndex + headingMatch[0].length) : "";

  const citedNumbers = new Set<number>();
  for (const match of body.matchAll(INLINE_CITATION)) {
    citedNumbers.add(Number(match[1]));
  }

  return {
    body,
    citedNumbers,
    entries: parseSourcesEntries(sourcesText),
    hasSourcesList,
    sourcesText,
  };
}

/**
 * Public accessor for the answer BODY only — the prose the model wrote,
 * minus the trailing Sources list. Reused by the Layer-3 groundedness grader
 * (`groundedness-grader.ts`), which needs the same "where does the Sources
 * list start" heuristic as `gradeSourcesFormat` etc. so that a Sources
 * bullet is never mistaken for a claim sentence to entailment-check.
 */
export function answerBody(answer: string): string {
  return parseAnswer(answer).body;
}

/**
 * Public accessor for the source paths the answer both cited inline AND
 * listed in its Sources list — the "resolved" citations (the intersection
 * `gradeCitationResolution` checks both halves of), deduplicated, in Sources-
 * list order. Reused by the real Layer-3 sweep (`eval/kb/kb-eval-models.spec.ts`,
 * Task 3.4) to build the groundedness premise material (`citedPassageTexts`)
 * from exactly the sources the answer claims to have used — not the full
 * retrieved set, which would let any retrieved-but-unused passage ground any
 * claim. A citation number with no Sources entry (`citation-unresolved`) or a
 * Sources entry never cited inline (`source-uncited`) is deliberately
 * excluded here — those are integrity failures `gradeCitationResolution`
 * already flags, not sources this grader should trust as premise material.
 */
export function citedSourcePaths(answer: string): string[] {
  const { citedNumbers, entries } = parseAnswer(answer);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!citedNumbers.has(entry.n)) continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    paths.push(entry.path);
  }
  return paths;
}

/**
 * The Sources region cut into candidate entries WITHOUT requiring a bullet.
 *
 * `citedSourcePaths` above reads the list through `BULLET_LINE` because the
 * gate grades the taught shape (`- [N] <path> — <position>`). This one exists
 * for the groundedness premise lookup, which needs a different question
 * answered: not "did the model format its list correctly?" — `sources-format`
 * owns that — but "which documents does the model say it used?". A model that
 * writes a perfectly legible ordered list has answered the second question;
 * charging it as if it answered neither is how one formatting defect became an
 * `ungrounded-claim` verdict (#869).
 *
 * The split is on line breaks and BEFORE each `[N]` marker, which is the one
 * token every shape the sweep produced has in common — bulleted, ordered,
 * marker-only, and the single-line run-on that has no line breaks to split on
 * at all. Empty fragments are dropped here; everything else is left to the
 * matcher, which resolves a fragment naming no retrieved document — a bare
 * `[1]`, the tail of an entry over-split on a `[2]` inside its own quoted
 * passage — to nothing. So over-splitting costs nothing.
 */
export function sourcesListCandidates(answer: string): string[] {
  return parseAnswer(answer)
    .sourcesText.split(/\r?\n|(?=\[\d+\])/)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0);
}

/**
 * Whether the answer BODY carries at least one inline `[N]` citation.
 *
 * Exported for the groundedness premise fallback, which is only sound for an
 * answer that claims a source for its claims at all. An answer that asserts
 * and then appends a Sources list without ever citing inline is charged by no
 * attribution axis — `gradeSourcesFormat` returns early on zero markers,
 * `gradeCitationResolution` has nothing on either side to compare — so it is
 * the one shape where recovering premise material could turn a failing run
 * into a passing one. See `premiseSourcePaths`.
 */
export function citesInline(answer: string): boolean {
  return parseAnswer(answer).citedNumbers.size > 0;
}

function passKb(): KbGraderResult {
  return { passed: true, tags: [], notes: [] };
}

function failKb(tag: KbFailureTag, notes: string[]): KbGraderResult {
  return { passed: false, tags: [tag], notes };
}

/**
 * Bidirectional inline↔Sources match. Both directions gate in ONE grader
 * because they are the two halves of the same contract ("the Sources list and
 * your inline citations must match exactly — no more and no fewer"):
 *
 * - `citation-unresolved` (cited-but-unlisted): an inline `[N]` has no
 *   matching Sources entry. The reader hits a dead end and cannot check that
 *   claim at all (Block-E: cites "[1][4]" inline, Sources holds only
 *   [1],[2],[5],[8] → [4] unresolved).
 * - `source-uncited` (listed-but-uncited): a Sources entry is never cited
 *   inline. Worse than noise — it dresses a single-source claim up as
 *   independently corroborated (Block-A: cites only [1] inline, but Sources
 *   also lists "[2] ..." — a returned-but-unused chunk).
 */
export function gradeCitationResolution(input: AttributionInput): KbGraderResult {
  const { citedNumbers, entries } = parseAnswer(input.answer);
  const entryByNumber = new Map(entries.map((entry) => [entry.n, entry]));

  const tags: KbFailureTag[] = [];
  const notes: string[] = [];

  const unresolved = [...citedNumbers].filter((n) => !entryByNumber.has(n)).sort((a, b) => a - b);
  if (unresolved.length > 0) {
    tags.push("citation-unresolved");
    notes.push(
      `Inline citation(s) [${unresolved.join("], [")}] have no matching Sources entry — the reader hits a dead end and cannot verify the claim.`
    );
  }

  const uncited = entries
    .filter((entry) => !citedNumbers.has(entry.n))
    .map((entry) => entry.n)
    .sort((a, b) => a - b);
  if (uncited.length > 0) {
    tags.push("source-uncited");
    notes.push(
      `Sources entry/entries [${uncited.join("], [")}] are listed but never cited inline — a retrieved-but-unused chunk presented as if it independently corroborates the answer.`
    );
  }

  if (tags.length === 0) return passKb();
  return { passed: false, tags, notes };
}

/**
 * `path-not-cited`: a Sources entry must name, in full, a document
 * `knowledge_search` actually returned. Three failure modes, one tag:
 * - the entry names no returned document — a fabricated or mangled path;
 * - it names two of them equally well (`policy.md` when both `handbook-2011/`
 *   and `handbook-2012/` came back) — the reader cannot tell which;
 * - it names only part of the path the document has — a bare filename where
 *   the corpus has folders, unfindable and ambiguous with same-named siblings.
 *
 * The rule is "as much path as the document HAS", not "contains a slash". The
 * first real Layer-3 sweep (#869) charged 19 of 43 runs here, and not one of
 * them named an unretrieved document: 12 of that corpus's 16 documents sit at
 * the data root, so their full citation path IS the bare filename, and the
 * slash test failed three correct citations in four. A citation-integrity axis
 * reading zero precisely when citation integrity is fine is worse than no axis.
 *
 * Matching is delegated to `cited-path-match.ts`, shared with the groundedness
 * premise lookup so the two cannot answer "which document is this?"
 * differently. It matches at segment boundaries, which is also what makes the
 * trailing annotations models really write — a quoted passage, a prose gloss,
 * a surrounding code span — irrelevant instead of fatal. `PAGE_SUFFIX` splits
 * off `— p. N` and nothing else, so every other annotation used to stay glued
 * to the path and turn an exact match into a mismatch.
 */
export function gradePathCitation(input: AttributionInput): KbGraderResult {
  const { entries } = parseAnswer(input.answer);

  const notes: string[] = [];
  for (const entry of entries) {
    const match = matchRetrievedDocument(entry.path, input.retrieved);
    if (match === null) {
      notes.push(
        `Sources entry [${entry.n}] cites path "${entry.path}", which does not match exactly one path in the returned sources.`
      );
      continue;
    }
    // The bar is the CITATION path: `retrieved` is built from the audit row,
    // which records the absolute sourcePath because that is a document's
    // identity, while the answer reproduces what `knowledge_search` printed,
    // which is data-root-relative (#933).
    //
    // Compared by LENGTH, not by equality of two normalized strings. What the
    // entry named is always one of `sourcePath`'s segment-boundary suffixes,
    // and those are nested — so "at least as long as the citation path" IS
    // "contains the whole citation path", for every form of it at once. An
    // answer echoing the absolute `/data/handbook-2012/policy.md`, or the
    // mount-relative `data/handbook-2012/policy.md`, named the whole document
    // and more; normalizing the two sides instead let the first through
    // (`toCitationPath` strips the `/data/`) and charged the second as a
    // "partial path" it is the opposite of — the #869 false alarm one shape
    // narrower, wearing a note that says the reverse of what happened.
    const full = toCitationPath(match.sourcePath);
    if (match.named.length >= full.length) continue;

    notes.push(
      match.named.includes("/")
        ? `Sources entry [${entry.n}] cites the partial path "${match.named}" instead of the full path "${full}" knowledge_search returned.`
        : `Sources entry [${entry.n}] cites the bare filename "${match.named}" instead of the full path "${full}" knowledge_search returned.`
    );
  }

  if (notes.length === 0) return passKb();
  return failKb("path-not-cited", notes);
}

/**
 * `sources-format`: every Sources entry must begin a line of its own IN THE
 * RENDERED ANSWER — otherwise the list collapses into one paragraph a reader
 * cannot walk. Two ways to fail it:
 *
 * - **An entry does not start its own rendered line.** Markdown separates lines
 *   in exactly three ways, and this accepts all three: a list item (`-`, `*`,
 *   `3.`), a blank line before it, or a hard break (two trailing spaces) before
 *   it. A lone `\n` is none of them, which is why "[1] a.md\n[2] b.md" fails
 *   and "[1] a.md  \n[2] b.md" does not.
 * - **A marker sits somewhere other than the head of an entry line**
 *   (`markerCount > entries with an explicit marker`) — the captured run-on
 *   bug, "**Sources:** [1] … p. 169 [4] … p. 194" on one line, where the second
 *   citation is buried mid-paragraph.
 *
 * The predecessor compared every `[N]` in the region against those leading a
 * `- `/`* ` bullet, and so charged the two separators that are not bullets. In
 * the 2026-08-05 sweep 15 of 17 `sources-format` verdicts went to lists that
 * render perfectly legibly — hard-break-separated, blank-line-separated, or
 * ordered. The axis was reporting a typographic preference as a defect.
 *
 * What it still charges, unchanged, is a list whose FIRST entry runs into the
 * heading ("**Sources:** [1] a.md"): that entry begins no line of its own, it
 * continues the heading's. The rule below is one sentence and this case is
 * inside it, rather than being a single-source exception bolted on.
 *
 * If the answer legitimately abstained and has NO Sources list at all, this
 * grader passes — there is no list to format-check.
 *
 * Marker normalisation moves this axis too, in the FAILING direction: a run-on
 * written entirely in fullwidth brackets ("**Sources:** 【1】 a.md 【2】 b.md") had
 * no markers this grader could see and passed — a run-on excused by the same
 * typography that emptied the premise set.
 */
export function gradeSourcesFormat(input: AttributionInput): KbGraderResult {
  const { hasSourcesList, sourcesText, entries } = parseAnswer(input.answer);
  if (!hasSourcesList) return passKb();

  const notes: string[] = [];

  const runOn = entries.filter(
    (entry) => !entry.isListItem && !RENDERED_SEPARATION.test(sourcesText.slice(0, entry.index))
  );
  if (runOn.length > 0) {
    notes.push(
      `Sources entry/entries [${runOn.map((entry) => entry.n).join("], [")}] do not begin a rendered line of their own — no list marker, blank line or hard break separates them from what precedes, so markdown runs them into one paragraph.`
    );
  }

  // Per line, and only AFTER whatever opens it: a marker at the head of an
  // entry line is that entry, not a buried one.
  const buried = sourcesText.split(/\r?\n/).filter((line) => {
    const head = SOURCES_ENTRY_HEAD.exec(line);
    return BURIED_MARKER.test(head ? line.slice(head[0].length) : line);
  });
  if (buried.length > 0) {
    notes.push(
      `Sources list carries a citation marker mid-line, with the source following it on the same line — a second entry buried in the paragraph rather than starting its own line: "${buried[0].trim()}"`
    );
  }

  if (notes.length === 0) return passKb();
  return failKb("sources-format", notes);
}

/**
 * `dedup-inflation`: if the Sources list cites >= 2 sources whose paths fall
 * in the SAME `nearDuplicateGroups` group, the answer presents near-identical
 * passages as independent corroboration of one claim. Retrieval legitimately
 * returns both (provenance/access-control per-path scoping requires it — see
 * `retrieval-eval.ts`), but the ANSWER must present one underlying fact as
 * one claim, not stack lookalike citations to appear better-supported than it
 * is. If `nearDuplicateGroups` is empty/undefined, this grader trivially
 * passes — there is nothing to compare against.
 *
 * Each entry is resolved to a retrieved document through
 * `matchRetrievedDocument`, the same way `gradePathCitation` and the
 * groundedness lookup resolve it — NOT by comparing the entry's raw path text
 * to a group's path. The groups name documents by their absolute corpus path
 * (`/data/petrifilm-datasheet.md`), while an answer cites the data-root-relative
 * form `knowledge_search` prints, usually inside a code span and followed by a
 * quoted passage. Against every one of the 48 answers in the published sweep, a
 * raw comparison matched nothing — so this grader would have reported a 0 that
 * still meant "not asked", one layer below the empty-group-list branch that
 * meant it before. An entry naming no retrieved document is skipped rather than
 * charged: a fabricated path is `path-not-cited`'s finding, and one defect
 * should not be counted under two tags.
 */
export function gradeNoDuplicateCorroboration(input: AttributionInput): KbGraderResult {
  const groups = input.nearDuplicateGroups ?? [];
  if (groups.length === 0) return passKb();

  const { entries } = parseAnswer(input.answer);
  const citedPaths = new Set(
    entries
      .map((entry) => matchRetrievedDocument(entry.path, input.retrieved)?.sourcePath)
      .filter((sourcePath): sourcePath is string => sourcePath !== undefined)
  );

  const notes: string[] = [];
  for (const group of groups) {
    const hit = group.filter((path) => citedPaths.has(path));
    if (hit.length >= 2) {
      notes.push(
        `Sources list co-cites ${hit.length} near-duplicate paths as independent corroboration: ${hit.join(", ")}.`
      );
    }
  }

  if (notes.length === 0) return passKb();
  return failKb("dedup-inflation", notes);
}

/**
 * Merges a set of `KbGraderResult`s into one: `passed` is true only if every
 * grader passes, `tags` is the de-duplicated union of all failing graders'
 * tags in stable execution order, and `notes` is the de-duplicated union of
 * every grader's notes (byte-identical notes collapsed, first-seen order
 * kept). Mirrors `graders.ts`'s `composeGraderResults`, but returns a
 * `KbGraderResult` (no `model`/`latencyMs`/`tokens` — those belong to the
 * invoice eval's `RunResult`, not a KB answer grade).
 *
 * Notes are de-duplicated for the same reason tags are: `gradeKbRun` runs
 * `gradePathCitation` twice against one retrieved set (once inside
 * `gradeAttribution`, once as `gradeCitationCorrectness` — see that function's
 * doc comment), so a real fabricated citation would otherwise emit the
 * identical note line twice. Collapsing byte-identical notes keeps the
 * human-readable forensics clean without losing any distinct diagnostic.
 */
export function composeKbGraderResults(results: KbGraderResult[]): KbGraderResult {
  const passed = results.every((result) => result.passed);
  const tagSet = new Set<KbFailureTag>();
  const tags: KbFailureTag[] = [];
  const noteSet = new Set<string>();
  const notes: string[] = [];

  for (const result of results) {
    for (const tag of result.tags) {
      if (!tagSet.has(tag)) {
        tagSet.add(tag);
        tags.push(tag);
      }
    }
    for (const note of result.notes) {
      if (!noteSet.has(note)) {
        noteSet.add(note);
        notes.push(note);
      }
    }
  }

  return { passed, tags, notes };
}

/**
 * Runs all four Layer-2 attribution graders and composes them into the
 * verdict for one answer.
 */
export function gradeAttribution(input: AttributionInput): KbGraderResult {
  return composeKbGraderResults([
    gradeCitationResolution(input),
    gradePathCitation(input),
    gradeSourcesFormat(input),
    gradeNoDuplicateCorroboration(input),
  ]);
}
