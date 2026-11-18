/**
 * The documents the index has a row for but could not make searchable (#935).
 *
 * A reindex reports `unsearchable` as a NUMBER, and a number nobody can expand
 * turns a known gap into a silent one: an agent that answers "I found nothing"
 * about a document it holds reads as a statement about the world, not about the
 * index. On the corpus this was measured against, 19 of 25 such documents were
 * certifications — the single most likely thing to be asked about.
 *
 * Read-side only, and deliberately derived rather than recorded: a document
 * with a kb_documents row and not one kb_chunks row produced no searchable
 * text, whatever the reason — a scan with no text layer, a spreadsheet with no
 * cells, a conversion that came back empty.
 *
 * One more kind of document is listed although it has chunks: an Office
 * document whose chunks were read from an artifact of an earlier format.
 * Search leaves it out until it is converted again (office-format-upgrade.ts,
 * retrieve.ts), and a conversion that keeps failing would otherwise leave it
 * out with no trace — found by no search, named by no list. It carries
 * `reason: "awaiting_conversion"`, every other entry `"no_text"`.
 *
 * What it does NOT cover is the ingest counter of the other name: a `failed`
 * file (unreadable/corrupt) usually has no document row at all, because ingest
 * extracts BEFORE inserting — so it cannot appear here. The two counters
 * describe different states and this list answers only one of them.
 *
 * It also answers over a WIDER window than the run summary it explains. A run's
 * `unsearchable` counts only what THAT run processed — a document unchanged
 * since the last index is `skipped` and never recounted — while this lists
 * everything currently in scope. So the list is normally larger than the last
 * run's number, and the two disagreeing is the expected case, not a bug. Any
 * surface showing them together has to say which window it means.
 *
 * Scale (#1364): a real share puts thousands of documents here, so the read
 * comes in three shapes — a summary (counts per reason, per cause and per
 * top-level folder), one folder's documents on request, and the full list
 * paged for a download. None of them holds the whole scope in memory.
 */
import { sql, type SQL } from "drizzle-orm";
import { basename, sep } from "node:path";

import { db } from "@/db";

import { EXTRACTION_VERSION, MAX_INCOMPLETE_READS } from "./ingest";
import type { KbOcrAvailability } from "./kb-ocr";
import { readFromSupersededArtifact } from "./office-format-upgrade";
import { buildPathFilter } from "./path-filter";

export type UnsearchableReason = "no_text" | "awaiting_conversion";

/**
 * Why a `no_text` document holds no text, as far as an admin can act on it
 * (#1362). Derived from what the index recorded about the last read
 * (`kb_documents.empty_extraction_by`) and whether a run started now would
 * read scans with a vision model — so the answer moves with the server's
 * setup, never with a guess in the page.
 *
 * - `ocr_off`: not read by a vision model, and reading scans is switched off
 *   on this server (`PINCHY_KB_OCR`).
 * - `no_vision_model`: not read by a vision model, and none is available.
 * - `read_next_run`: the next run reads it again — a vision model is
 *   available that has not read it yet, its last read did not finish, or an
 *   older extractor read it.
 * - `read_refused`: the converter or the workbook reader turned it away — too
 *   large, damaged, not what its name says; the server log names the file and
 *   the reason. A workbook with nothing visible in it (no cells, or every
 *   sheet hidden) lands here too: its record looks the same as a refused
 *   one's. Only a replaced file is read again.
 * - `vision_failed`: every vision read of it failed, five runs in a row. Read
 *   again once a different vision model is configured, or the file replaced.
 * - `read_blank`: read in full, scanned pages by a vision model, and nothing
 *   found. Changing the OCR setup changes nothing for it.
 */
export type NoTextCause =
  "ocr_off" | "no_vision_model" | "read_next_run" | "read_refused" | "vision_failed" | "read_blank";

export interface UnsearchableDocument {
  /** Absolute path of the source file, as indexed. */
  sourcePath: string;
  /** The file name — the part an admin recognizes. */
  name: string;
  /** The granted folder the document sits under: the narrowest one, when grants nest. */
  root: string;
  /** The folder it sits in, relative to `root`; "" when it sits directly in `root`. */
  folder: string;
  /** `archived` means the document sits under an OLD/Archive folder (archive-paths.ts) and is already out of everyday search. */
  status: "active" | "archived";
  /**
   * `no_text`: indexed, but it produced no searchable text. `awaiting_conversion`:
   * a Word or PowerPoint document search leaves out until it is converted again
   * under the current conversion rules.
   */
  reason: UnsearchableReason;
  /** Why it holds no text; null for `awaiting_conversion`, which has text and waits for a conversion instead. */
  cause: NoTextCause | null;
}

/** One top-level folder below a grant. `folder: null` stands for the files sitting directly in `root`. */
export interface UnsearchableGroup {
  root: string;
  folder: string | null;
  count: number;
}

export interface UnsearchableSummary {
  total: number;
  /** `total` split by reason. The two call for different words, so the page needs both numbers. */
  totals: Record<UnsearchableReason, number>;
  /** The `no_text` documents split by cause; sums to `totals.no_text`. */
  causes: Record<NoTextCause, number>;
  /** Largest first; sums to `total`. */
  groups: UnsearchableGroup[];
}

export interface UnsearchableDocumentsResult {
  /** At most `limit` documents, active ones first, then by path. */
  documents: UnsearchableDocument[];
  /** How many there are in the scope asked for — never truncated by `limit`, so a capped list can say what it is hiding. */
  total: number;
}

/** How many documents one call returns by default. `total` keeps the answer honest past the cap; the download has the rest. */
export const DEFAULT_UNSEARCHABLE_LIMIT = 100;

/** How many rows one page of the full list reads. */
const DEFAULT_PAGE_SIZE = 1000;

/**
 * Why a `no_text` document holds no text, from its record, how many reads in
 * a row did not finish, and the OCR a run started now would have. Mirrors
 * ingest's own decision to read a document again (ingest.ts, `retryOwed`,
 * `couldReadDifferently` and the skip between them), so the page never
 * promises a read the next run won't do, nor blames the OCR setup for a file
 * no OCR setting would read.
 */
export function noTextCause(
  record: string | null,
  incompleteReads: number,
  ocr: KbOcrAvailability
): NoTextCause {
  // A read that did not finish is owed another one, whatever OCR the server
  // has — and its record is not written until it settles.
  if (incompleteReads > 0 && incompleteReads < MAX_INCOMPLETE_READS) return "read_next_run";

  // "<extraction version>|<reader>", as ingest writes it.
  const parts = record === null ? null : /^([^|]*)\|([\s\S]*)$/.exec(record);
  const recorded = parts?.[2] ?? null;
  const current = parts !== null && parts[1] === String(EXTRACTION_VERSION);
  // An older extractor's record from a reader no vision model enters into:
  // ingest reads it again with the current extractor, whatever OCR is.
  if (!current && (recorded === "sheets" || recorded === "converter")) return "read_next_run";
  // No record (one from before the record existed) or a scan's record an older
  // extractor wrote: ingest reads it again, with whatever OCR the run has —
  // the same as a scan read without OCR.
  const reader = current && recorded !== null ? recorded : "no-ocr";

  if (reader === "no-ocr") {
    if (ocr.state === "off") return "ocr_off";
    if (ocr.state === "no_model") return "no_vision_model";
    return "read_next_run";
  }
  if (reader.startsWith("ocr:")) {
    if (ocr.state === "on" && `ocr:${ocr.model}` !== reader) return "read_next_run";
    // Out of retries: every vision read failed, so it was never read in full.
    return incompleteReads >= MAX_INCOMPLETE_READS ? "vision_failed" : "read_blank";
  }
  // The converter and the workbook reader come back empty when they refuse a
  // file. Once that is on record, neither is tried again on the same bytes.
  return "read_refused";
}

/**
 * The grants as folders: trailing separators dropped and duplicates merged,
 * longest first so the first match is the narrowest grant.
 */
function grantRoots(allowedPaths: readonly string[]): string[] {
  const roots = new Set(
    allowedPaths.map((p) => (p.length > 1 && p.endsWith(sep) ? p.replace(/\/+$/, "") || sep : p))
  );
  return [...roots].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * The scoped documents with their grant root and top-level folder, as a
 * subquery. One definition for every read below, so the summary, a group and
 * the download cannot disagree about which documents are in scope or where
 * they sit.
 */
function scopedDocuments(orgId: string, roots: string[]): SQL {
  const column = sql`d.source_path`;
  const superseded = readFromSupersededArtifact(column, sql`d.artifact_format_version`);
  const rootCase = sql.join(
    roots.map((root) => sql`WHEN ${buildPathFilter([root], column)} THEN ${root}`),
    sql` `
  );
  return sql`
    SELECT s.*,
           CASE WHEN strpos(s.rel, ${sep}) > 0 THEN split_part(s.rel, ${sep}, 1) END AS top_folder
    FROM (
      SELECT r.*,
             CASE WHEN r.source_path = r.root THEN ''
                  ELSE substr(r.source_path,
                              char_length(CASE WHEN right(r.root, 1) = ${sep} THEN r.root
                                               ELSE r.root || ${sep} END) + 1)
             END AS rel
      FROM (
        SELECT d.source_path,
               d.status,
               d.empty_extraction_by,
               d.incomplete_reads,
               (${superseded}) AS awaiting,
               CASE ${rootCase} END AS root
        FROM kb_documents d
        WHERE d.org_id = ${orgId}
          AND (${buildPathFilter(roots, column)})
          -- "Has no chunk", correlated on document_id — NOT on source_path. The
          -- two disagree exactly when two documents share a path, which
          -- (org_id, source_path) being unique makes an ACL duplicate across
          -- orgs; matching by path would let one org's text vouch for another's
          -- scan.
          AND (NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.document_id = d.id)
               OR ${superseded})
      ) r
    ) s
  `;
}

interface DocumentRow extends Record<string, unknown> {
  source_path: string;
  status: "active" | "archived";
  empty_extraction_by: string | null;
  incomplete_reads: number;
  awaiting: boolean;
  root: string;
}

function toDocument(row: DocumentRow, ocr: KbOcrAvailability): UnsearchableDocument {
  const prefix = row.root.endsWith(sep) ? row.root : row.root + sep;
  const rel =
    row.source_path === row.root ? basename(row.source_path) : row.source_path.slice(prefix.length);
  const cut = rel.lastIndexOf(sep);
  const reason: UnsearchableReason = row.awaiting ? "awaiting_conversion" : "no_text";
  return {
    sourcePath: row.source_path,
    name: cut < 0 ? rel : rel.slice(cut + 1),
    root: row.root,
    folder: cut < 0 ? "" : rel.slice(0, cut),
    status: row.status,
    reason,
    cause:
      reason === "no_text" ? noTextCause(row.empty_extraction_by, row.incomplete_reads, ocr) : null,
  };
}

const emptyCauses = (): Record<NoTextCause, number> => ({
  ocr_off: 0,
  no_vision_model: 0,
  read_next_run: 0,
  read_refused: 0,
  vision_failed: 0,
  read_blank: 0,
});

/**
 * Counts the unsearchable documents for `orgId` in `allowedPaths`: per
 * reason, per cause and per top-level folder below each grant.
 *
 * The scope is the SAME allow-list that scopes retrieval (path-filter.ts), for
 * the same reason: an agent must never learn that a document exists outside the
 * directories it was granted. An empty `allowedPaths` denies by default without
 * touching the database — an agent granted nothing sees nothing, not
 * everything. The same holds for every read in this module.
 */
export async function summarizeUnsearchableDocuments(
  orgId: string,
  allowedPaths: readonly string[],
  ocr: KbOcrAvailability
): Promise<UnsearchableSummary> {
  const summary: UnsearchableSummary = {
    total: 0,
    totals: { no_text: 0, awaiting_conversion: 0 },
    causes: emptyCauses(),
    groups: [],
  };
  if (allowedPaths.length === 0) return summary;

  // Grouped by the record and the retry count as well, because the cause is
  // derived from them in code: they take a handful of values per corpus, so
  // this stays a short list however many documents it counts.
  const rows = await db.execute<{
    root: string;
    top_folder: string | null;
    awaiting: boolean;
    empty_extraction_by: string | null;
    incomplete_reads: number;
    n: string | number;
  }>(sql`
    SELECT root, top_folder, awaiting, empty_extraction_by, incomplete_reads, COUNT(*) AS n
    FROM (${scopedDocuments(orgId, grantRoots(allowedPaths))}) scoped
    GROUP BY root, top_folder, awaiting, empty_extraction_by, incomplete_reads
  `);

  const groups = new Map<string, UnsearchableGroup>();
  for (const row of rows) {
    const n = Number(row.n);
    summary.total += n;
    if (row.awaiting) {
      summary.totals.awaiting_conversion += n;
    } else {
      summary.totals.no_text += n;
      summary.causes[noTextCause(row.empty_extraction_by, row.incomplete_reads, ocr)] += n;
    }
    const key = JSON.stringify([row.root, row.top_folder]);
    const group = groups.get(key) ?? { root: row.root, folder: row.top_folder, count: 0 };
    group.count += n;
    groups.set(key, group);
  }

  // Largest first: the folder holding most of the gap is where an admin looks.
  summary.groups = [...groups.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.root.localeCompare(b.root) ||
      (a.folder === null ? -1 : b.folder === null ? 1 : a.folder.localeCompare(b.folder))
  );
  return summary;
}

/**
 * Lists the unsearchable documents for `orgId` in `allowedPaths`, or in one
 * group of it.
 *
 * A group names a grant and a top-level folder below it (`folder: null` for
 * the files directly in the grant). A group whose root is not one of the
 * agent's grants answers nothing: the request never widens the scope past the
 * allow-list. The folder is matched by equality, so `_` and `%` in a folder
 * name are ordinary characters.
 */
export async function listUnsearchableDocuments(
  orgId: string,
  allowedPaths: readonly string[],
  ocr: KbOcrAvailability,
  opts: { limit?: number; group?: { root: string; folder: string | null } } = {}
): Promise<UnsearchableDocumentsResult> {
  if (allowedPaths.length === 0) return { documents: [], total: 0 };

  const roots = grantRoots(allowedPaths);
  let groupFilter = sql`TRUE`;
  if (opts.group) {
    const [root] = grantRoots([opts.group.root]);
    if (!roots.includes(root)) return { documents: [], total: 0 };
    groupFilter =
      opts.group.folder === null
        ? sql`root = ${root} AND top_folder IS NULL`
        : sql`root = ${root} AND top_folder = ${opts.group.folder}`;
  }

  const rows = await db.execute<DocumentRow & { total: string | number }>(sql`
    SELECT source_path, status, empty_extraction_by, incomplete_reads, awaiting, root,
           -- The pre-LIMIT count, in the same pass: the cap truncates the
           -- list, never the number. A separate COUNT can disagree with the
           -- page it labels.
           COUNT(*) OVER () AS total
    FROM (${scopedDocuments(orgId, roots)}) scoped
    WHERE ${groupFilter}
    -- Archived documents last: they are already out of everyday search
    -- (archive-paths.ts), so a capped window should fill with the ones a
    -- question is actually going to hit.
    ORDER BY (status = 'archived'), source_path
    LIMIT ${opts.limit ?? DEFAULT_UNSEARCHABLE_LIMIT}
  `);

  return {
    documents: rows.map((row) => toDocument(row, ocr)),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

/**
 * Every unsearchable document in `allowedPaths`, page by page in path order —
 * the full list behind the download. Keyset-paged on the path (unique per
 * org), so a page is one indexed range read however deep the list goes, and
 * nothing is lost or repeated between pages.
 */
export async function* unsearchableDocumentPages(
  orgId: string,
  allowedPaths: readonly string[],
  ocr: KbOcrAvailability,
  opts: { pageSize?: number } = {}
): AsyncGenerator<UnsearchableDocument[], void, undefined> {
  if (allowedPaths.length === 0) return;

  const roots = grantRoots(allowedPaths);
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  let after: string | null = null;

  for (;;) {
    const rows: DocumentRow[] = await db.execute<DocumentRow>(sql`
      SELECT source_path, status, empty_extraction_by, incomplete_reads, awaiting, root
      FROM (${scopedDocuments(orgId, roots)}) scoped
      WHERE ${after === null ? sql`TRUE` : sql`source_path > ${after}`}
      ORDER BY source_path
      LIMIT ${pageSize}
    `);
    if (rows.length === 0) return;
    yield rows.map((row) => toDocument(row, ocr));
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1].source_path;
  }
}
