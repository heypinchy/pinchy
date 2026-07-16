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

/** One parsed `- [N] <path> — p. <page>` bullet from the Sources list. */
interface SourcesEntry {
  n: number;
  path: string;
  page: number | null;
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
 */
const SOURCES_HEADING =
  /^[ \t]*#{0,3}[ \t]*\*{0,2}[ \t]*Sources[ \t]*(?::[ \t]*\*{0,2}|\*{0,2}[ \t]*:)/gm;

/** Any `[N]` marker, inline citation or Sources-bullet citation number alike. */
const INLINE_CITATION = /\[(\d+)\]/g;

/**
 * A Sources-list bullet: `- [N] <rest of line>` (or `*` bullets), one per
 * line. Requires the `[N]` to be the first thing on a bulleted line — this is
 * exactly what distinguishes a real markdown list from the run-on-paragraph
 * bug, where citations appear mid-line with no bullet marker at all.
 */
const BULLET_LINE = /^[ \t]*[-*][ \t]+\[(\d+)\]\s*(.+)$/gm;

/**
 * Trailing page suffix on a Sources entry's rest-of-line text — separates the
 * PATH (group 1) from the page reference (group 2). Non-greedy path capture so
 * a hyphen inside the path itself (e.g. "/data/handbook-2012/policy.md") is not
 * mistaken for the dash separator — the required "p."/"pp." literal after the
 * dash disambiguates. Accepts a single page (`— p. 12`), a page range
 * (`— p. 12-14`), and the `pp.` plural (`— pp. 12-14`); the alternative
 * en-dash separator is tolerated inside the range too. A Sources entry with no
 * page suffix at all (a legitimate, if degraded, shape) leaves `pageMatch`
 * null and parses with `page: null` — the point of widening this is to keep a
 * range from folding into `entry.path` and spuriously failing the exact
 * path-match in `gradePathCitation`. `page` stores the FIRST page number
 * (`parseInt` of the range) — it is not asserted downstream yet.
 */
const PAGE_SUFFIX = /^(.*?)\s*[—-]\s*pp?\.?\s*(\d+(?:\s*[-–]\s*\d+)?)\s*$/i;

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

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function parseSourcesEntries(sourcesText: string): SourcesEntry[] {
  const entries: SourcesEntry[] = [];
  for (const match of sourcesText.matchAll(BULLET_LINE)) {
    const n = Number(match[1]);
    const rest = match[2].trim();
    const pageMatch = PAGE_SUFFIX.exec(rest);
    entries.push(
      pageMatch
        ? { n, path: pageMatch[1].trim(), page: Number.parseInt(pageMatch[2], 10) }
        : { n, path: rest, page: null }
    );
  }
  return entries;
}

/** Splits `answer` into its cited-body and Sources-list halves and parses both. */
function parseAnswer(answer: string): ParsedAnswer {
  // Take the LAST line-start heading match: the real Sources list is always
  // the trailing block, so an earlier mid-prose "Sources:" mention never wins
  // the split. `matchAll` (not `.exec`) avoids the stateful-`lastIndex`
  // footgun of a `g`-flagged regex.
  const headingMatches = [...answer.matchAll(SOURCES_HEADING)];
  const headingMatch = headingMatches.at(-1) ?? null;
  const hasSourcesList = headingMatch !== null;
  const headingIndex = headingMatch?.index ?? 0;
  const body = hasSourcesList ? answer.slice(0, headingIndex) : answer;
  const sourcesText = hasSourcesList ? answer.slice(headingIndex + headingMatch[0].length) : "";

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
 * `path-not-cited`: a Sources entry must reproduce the full path
 * `knowledge_search` gave the model, exactly. Flags either failure mode:
 * - a bare filename (no `/`) — unfindable in a deep corpus and ambiguous
 *   across same-named files in different folders;
 * - a path that does not match any `retrieved[].sourcePath` — a fabricated
 *   or mangled path the model didn't actually get from the tool.
 */
export function gradePathCitation(input: AttributionInput): KbGraderResult {
  const { entries } = parseAnswer(input.answer);
  const retrievedPaths = new Set(input.retrieved.map((source) => source.sourcePath));

  const notes: string[] = [];
  for (const entry of entries) {
    if (!entry.path.includes("/")) {
      notes.push(
        `Sources entry [${entry.n}] cites the bare filename "${entry.path}" instead of the full path knowledge_search returned.`
      );
      continue;
    }
    if (!retrievedPaths.has(entry.path)) {
      notes.push(
        `Sources entry [${entry.n}] cites path "${entry.path}", which does not match any path in the returned sources.`
      );
    }
  }

  if (notes.length === 0) return passKb();
  return failKb("path-not-cited", notes);
}

/**
 * `sources-format`: the Sources list must be a markdown bullet list, one
 * entry per `- [N] ...` line — plain consecutive lines (or a single run-on
 * line) collapse into one unreadable paragraph when rendered. Detected by
 * comparing two counts within the text AFTER the "Sources:" heading: every
 * `[N]` marker found anywhere (`looseCount`) vs. only those that lead a
 * bulleted line (`bulletedCount`). A mismatch means at least one citation is
 * NOT on its own bulleted line — including the degenerate case where NONE
 * are (the real captured bug: "Sources: [1] ... p. 169 [4] ... p. 194" all on
 * one line, `bulletedCount === 0`).
 *
 * A single source still must be bulleted: `looseCount === 1` with
 * `bulletedCount === 0` fails just as a multi-source run-on does.
 *
 * If the answer legitimately abstained and has NO Sources list at all, this
 * grader passes — there is no list to format-check.
 */
export function gradeSourcesFormat(input: AttributionInput): KbGraderResult {
  const { hasSourcesList, sourcesText } = parseAnswer(input.answer);
  if (!hasSourcesList) return passKb();

  const looseCount = countMatches(sourcesText, INLINE_CITATION);
  if (looseCount === 0) return passKb();

  const bulletedCount = countMatches(sourcesText, BULLET_LINE);
  if (looseCount === bulletedCount) return passKb();

  return failKb("sources-format", [
    `Sources list has ${looseCount} citation marker(s) but only ${bulletedCount} sit on their own "- [N] ..." bulleted line — likely a run-on paragraph instead of a markdown bullet list.`,
  ]);
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
 */
export function gradeNoDuplicateCorroboration(input: AttributionInput): KbGraderResult {
  const groups = input.nearDuplicateGroups ?? [];
  if (groups.length === 0) return passKb();

  const { entries } = parseAnswer(input.answer);
  const citedPaths = new Set(entries.map((entry) => entry.path));

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
 * tags in stable execution order, and `notes` is the concatenation of every
 * grader's notes. Mirrors `graders.ts`'s `composeGraderResults`, but returns a
 * `KbGraderResult` (no `model`/`latencyMs`/`tokens` — those belong to the
 * invoice eval's `RunResult`, not a KB answer grade).
 */
export function composeKbGraderResults(results: KbGraderResult[]): KbGraderResult {
  const passed = results.every((result) => result.passed);
  const tagSet = new Set<KbFailureTag>();
  const tags: KbFailureTag[] = [];
  const notes: string[] = [];

  for (const result of results) {
    for (const tag of result.tags) {
      if (!tagSet.has(tag)) {
        tagSet.add(tag);
        tags.push(tag);
      }
    }
    notes.push(...result.notes);
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
