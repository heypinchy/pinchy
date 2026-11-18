/**
 * The groundedness premise lookup for the Layer-3 sweep, extracted from
 * `kb-eval-models.spec.ts` so a DB-backed test can reach it.
 *
 * It lives outside `kb-eval-shared.ts` on purpose: that module imports
 * `@playwright/test`, and pulling Playwright into the vitest integration lane
 * to test one SQL statement would be a much larger dependency than the thing
 * under test.
 */

/**
 * Fetches every chunk's `chunk_text` for the given `sourcePaths`, keyed by
 * path — the groundedness premise material for whichever sources the answer's
 * Sources list actually cited (`citedSourcePaths`, not the full retrieved set
 * — see that function's doc comment for why). A direct SELECT against the
 * already-seeded corpus, not a re-run of `retrieve()`: we already know exactly
 * which paths were retrieved (from the audit row), so this needs no new
 * search/embedding call, only the stored text.
 */
export async function fetchChunkTexts(
  dbUrl: string,
  orgId: string,
  sourcePaths: string[]
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (sourcePaths.length === 0) return map;

  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  try {
    // Interpolate the array directly. `sql.array(paths)` reads like the more
    // explicit spelling and is the one that does not work: postgres.js already
    // infers `text[]` from a string array, while `sql.array` produces a
    // parameter Postgres rejects on the right side of ANY (#869).
    const rows = await sql<{ source_path: string; chunk_text: string }[]>`
      SELECT source_path, chunk_text FROM kb_chunks
      WHERE org_id = ${orgId} AND source_path = ANY(${sourcePaths})
    `;
    for (const row of rows) {
      const texts = map.get(row.source_path) ?? [];
      texts.push(row.chunk_text);
      map.set(row.source_path, texts);
    }
    return map;
  } finally {
    await sql.end();
  }
}
