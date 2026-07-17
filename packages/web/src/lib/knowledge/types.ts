/**
 * Knowledge-base contracts shared across layers.
 *
 * A types-only module (no imports, no runtime): `IngestResult` is written by
 * ingest.ts, persisted as a jsonb column by db/schema.ts, and read back by the
 * job store and the reindex routes. ingest.ts imports db/schema, so the schema
 * cannot import IngestResult from ingest.ts without a cycle — the same reason
 * email-workflows/types exists.
 */

export interface IngestPage {
  page: number;
  text: string;
}

export interface IngestResult {
  /** Documents newly indexed, replaced due to a content change, or recovered from a zero-chunk state — and searchable afterwards (at least one chunk). */
  indexed: number;
  /** Documents left untouched: unchanged content hash, chunks already present. */
  skipped: number;
  /** Documents deleted because their source file is no longer on disk. */
  removed: number;
  /**
   * Files that parsed without error but yielded no chunks, so they are indexed
   * yet can never be retrieved — an image-only scan with no text layer is the
   * normal cause. Counted apart from `indexed` because the counts exist to
   * answer "is the corpus findable?", and folding these into `indexed` reports
   * a complete corpus while a slice of it silently answers nothing.
   */
  unsearchable: number;
  /** Files skipped because reading or extracting THIS file threw (unreadable, corrupt). The run continues; see the per-file boundary in ingestDirectory. */
  failed: number;
}

/** A fresh IngestResult with every counter at zero — the identity for summing per-root results. A function, not a shared const, so no caller can mutate the zero. */
export function zeroIngestResult(): IngestResult {
  return { indexed: 0, skipped: 0, removed: 0, unsearchable: 0, failed: 0 };
}

/**
 * Sums ingest results. Written out field by field on purpose: a counter added
 * to IngestResult fails to compile here until it is summed, so a new counter
 * cannot silently drop out of the numbers an admin sees.
 */
export function totalCounts(results: readonly IngestResult[]): IngestResult {
  return results.reduce<IngestResult>(
    (total, result) => ({
      indexed: total.indexed + result.indexed,
      skipped: total.skipped + result.skipped,
      removed: total.removed + result.removed,
      unsearchable: total.unsearchable + result.unsearchable,
      failed: total.failed + result.failed,
    }),
    zeroIngestResult()
  );
}
