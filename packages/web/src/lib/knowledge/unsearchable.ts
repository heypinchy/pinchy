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
 * text, whatever the reason. Today that is a scan with no text layer; when
 * Office conversion lands, a document whose conversion failed lands in this
 * list too, with nothing to wire up.
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
 */
import { sql } from "drizzle-orm";

import { db } from "@/db";

import { buildPathFilter } from "./path-filter";

export interface UnsearchableDocument {
  /** Absolute path of the source file, as indexed. The full path, not a basename — two folders may hold the same filename. */
  sourcePath: string;
  /** `archived` means the document sits under an OLD/Archive folder (archive-paths.ts) and is already out of everyday search. */
  status: "active" | "archived";
}

export interface UnsearchableDocumentsResult {
  /** At most `limit` documents, active ones first, then by path. */
  documents: UnsearchableDocument[];
  /** How many there are in total — never truncated by `limit`, so a capped list can say what it is hiding. */
  total: number;
}

/** How many documents one call returns by default. A real corpus can hold hundreds; `total` keeps the answer honest past the cap. */
export const DEFAULT_UNSEARCHABLE_LIMIT = 100;

interface UnsearchableRow extends Record<string, unknown> {
  source_path: string;
  status: "active" | "archived";
  total: string | number;
}

/**
 * Lists the unsearchable documents for `orgId`, scoped to `allowedPaths`.
 *
 * The scope is the SAME allow-list that scopes retrieval (path-filter.ts), for
 * the same reason: an agent must never learn that a document exists outside the
 * directories it was granted. An empty `allowedPaths` denies by default and
 * returns an empty result without touching the database — an agent granted
 * nothing sees nothing, not everything.
 */
export async function listUnsearchableDocuments(
  orgId: string,
  allowedPaths: readonly string[],
  opts: { limit?: number } = {}
): Promise<UnsearchableDocumentsResult> {
  if (allowedPaths.length === 0) return { documents: [], total: 0 };

  const limit = opts.limit ?? DEFAULT_UNSEARCHABLE_LIMIT;
  const pathFilter = buildPathFilter(allowedPaths, sql`d.source_path`);

  const rows = await db.execute<UnsearchableRow>(sql`
    SELECT d.source_path,
           d.status,
           -- The pre-LIMIT count, in the same pass: the cap truncates the
           -- list, never the number. A window function beats a second query
           -- here because both would have to agree, and a separate COUNT can
           -- disagree with the page it labels.
           COUNT(*) OVER () AS total
    FROM kb_documents d
    WHERE d.org_id = ${orgId}
      AND (${pathFilter})
      -- "Has no chunk", correlated on document_id — NOT on source_path. The
      -- two disagree exactly when two documents share a path, which
      -- (org_id, source_path) being unique makes an ACL duplicate across orgs;
      -- matching by path would let one org's text vouch for another's scan.
      AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.document_id = d.id)
    -- Archived documents last: they are already out of everyday search
    -- (archive-paths.ts), so a capped window should fill with the ones a
    -- question is actually going to hit.
    ORDER BY (d.status = 'archived'), d.source_path
    LIMIT ${limit}
  `);

  return {
    documents: rows.map((row) => ({ sourcePath: row.source_path, status: row.status })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}
