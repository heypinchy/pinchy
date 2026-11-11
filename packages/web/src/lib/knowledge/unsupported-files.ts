/**
 * The files under an agent's granted folders whose type the indexer cannot
 * read (#1267) — an Outlook `.msg`, a legacy `.xls`, a `.rtf`.
 *
 * Discovery already sees them: it walks every file and drops the ones outside
 * the extension allowlist (exclude-globs.ts). Until this module it dropped them
 * without a trace — no document row, no counter, no list — so a folder of 13
 * files indexed as 11 and the other two appeared nowhere. An admin who cannot
 * see which documents the agent cannot answer from reads the gap as a model
 * problem.
 *
 * Hidden files, OS artifacts and temp files (`Thumbs.db`, `~$Report.docx`,
 * `*.tmp`) are NOT listed: they were never documents, and listing them would
 * bury the scans an admin actually has to convert.
 *
 * Stored as current state, one row per file (kb_unsupported_files): a run
 * replaces the rows under the folders it walked. That bounds the table by the
 * share, not by the number of nights, and keeps the list out of the job row
 * and the audit row — a real share holds 100k+ such files, and an audit
 * `detail` holds 2 KB.
 */
import { sql } from "drizzle-orm";

import { db } from "@/db";
import { kbUnsupportedFiles } from "@/db/schema";
import { inBatches, rowsPerInsert } from "@/db/insert-batches";

import { buildPathFilter } from "./path-filter";
import { unsupportedFileKind, type UnsupportedFileKind } from "./unsupported-kind";

export interface UnsupportedFile {
  /** Absolute path of the file, as discovery found it. */
  sourcePath: string;
  /** Lowercased extension with its dot (".tif"), or "" for a file without one. */
  type: string;
}

/** One root as a run walked it, and the unsupported files it found there. */
export interface UnsupportedScan {
  rootDir: string;
  /** Path → type, as `unsupportedFileType` names it. */
  files: ReadonlyMap<string, string>;
}

/** The type a file is listed under: its extension, lowercased — "" when it has none. */
export function unsupportedFileType(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension — and hidden files
  // never reach this list anyway (see the module docblock).
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

/** Rows per page on the read side. */
export const DEFAULT_UNSUPPORTED_PAGE_SIZE = 1000;

/**
 * Replaces what is recorded under each walked root with what this run found.
 *
 * `keep` names folders the run had to leave as they were — a root it could not
 * read, a folder that came up empty while the index still held documents from
 * it (a share that failed to mount). Their rows stay: a folder nobody could
 * look into is no evidence that its files are gone. The same rule the removal
 * pass follows for documents (ingest.ts).
 *
 * One transaction, so a reader never sees a folder between its delete and its
 * insert — an export taken mid-run lists the last run's files, not none.
 */
export async function recordUnsupportedFiles(
  orgId: string,
  scans: readonly UnsupportedScan[],
  keep: readonly string[]
): Promise<void> {
  if (scans.length === 0) return;

  // Overlapping roots (/data and /data/hr) find the same file twice; it is one row.
  const rows = new Map<string, string>();
  for (const scan of scans) for (const [path, type] of scan.files) rows.set(path, type);

  const walked = buildPathFilter(
    scans.map((scan) => scan.rootDir),
    sql`source_path`
  );
  const kept = keep.length > 0 ? sql`AND NOT (${buildPathFilter(keep, sql`source_path`)})` : sql``;

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM kb_unsupported_files
      WHERE org_id = ${orgId} AND (${walked}) ${kept}
    `);
    const values = [...rows].map(([sourcePath, fileType]) => ({ orgId, sourcePath, fileType }));
    for (const batch of inBatches(values, rowsPerInsert(kbUnsupportedFiles))) {
      await tx
        .insert(kbUnsupportedFiles)
        .values(batch)
        // A kept folder's row and a fresh find of the same path (a kept folder
        // under one root, walked under another) are the same file.
        .onConflictDoNothing();
    }
  });
}

/**
 * How many unsupported files the agent's grants cover. An empty grant list
 * denies by default — an agent granted nothing sees nothing.
 */
export async function countUnsupportedFiles(
  orgId: string,
  allowedPaths: readonly string[]
): Promise<number> {
  if (allowedPaths.length === 0) return 0;
  const rows = await db.execute<{ total: string | number }>(sql`
    SELECT COUNT(*) AS total FROM kb_unsupported_files
    WHERE org_id = ${orgId} AND (${buildPathFilter(allowedPaths, sql`source_path`)})
  `);
  return Number(rows[0]?.total ?? 0);
}

/**
 * The same count split the way an admin reads it (#1410): documents Pinchy
 * cannot read yet, and files that are not documents at all. Grouped by type in
 * SQL — a share holds a handful of types and 100k+ files — and classified here,
 * so unsupported-kind.ts stays the one place that draws the line.
 */
export async function countUnsupportedFilesByKind(
  orgId: string,
  allowedPaths: readonly string[]
): Promise<Record<UnsupportedFileKind, number>> {
  const counts: Record<UnsupportedFileKind, number> = { unsupported: 0, ignored: 0 };
  if (allowedPaths.length === 0) return counts;
  const rows = await db.execute<{ file_type: string; total: string | number }>(sql`
    SELECT file_type, COUNT(*) AS total FROM kb_unsupported_files
    WHERE org_id = ${orgId} AND (${buildPathFilter(allowedPaths, sql`source_path`)})
    GROUP BY file_type
  `);
  for (const row of rows) counts[unsupportedFileKind(row.file_type)] += Number(row.total);
  return counts;
}

/**
 * The unsupported files the agent's grants cover, ordered by path, one page at
 * a time.
 *
 * Paged by key (`source_path > last`) rather than by OFFSET, so a 100k-row
 * export costs each page the same and never holds the whole list — neither in
 * Postgres nor in the process streaming it out. Scoped by the SAME allow-list
 * that scopes retrieval (path-filter.ts): an agent must never learn that a file
 * exists outside the folders it was granted.
 */
export async function* listUnsupportedFiles(
  orgId: string,
  allowedPaths: readonly string[],
  opts: { pageSize?: number } = {}
): AsyncGenerator<UnsupportedFile[]> {
  if (allowedPaths.length === 0) return;
  const pageSize = opts.pageSize ?? DEFAULT_UNSUPPORTED_PAGE_SIZE;
  const scope = buildPathFilter(allowedPaths, sql`source_path`);

  let after: string | null = null;
  for (;;) {
    const cursor: ReturnType<typeof sql> = after === null ? sql`` : sql`AND source_path > ${after}`;
    const rows: Array<{ source_path: string; file_type: string }> = await db.execute<{
      source_path: string;
      file_type: string;
    }>(sql`
      SELECT source_path, file_type FROM kb_unsupported_files
      WHERE org_id = ${orgId} AND (${scope}) ${cursor}
      ORDER BY source_path
      LIMIT ${pageSize}
    `);
    if (rows.length === 0) return;
    yield rows.map((row) => ({ sourcePath: row.source_path, type: row.file_type }));
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1].source_path;
  }
}
