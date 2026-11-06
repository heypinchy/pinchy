/**
 * Which indexed passage on a cited page an answer drew on (#1268).
 *
 * A citation names a document and a page; the reader wants the sentence.
 * Chunks never cross a page (chunk.ts chunks each page on its own), so the page
 * narrows the candidates to the one to three ~512-token passages of that page.
 * When there is more than one, the answer's claim — the sentences citing the
 * source — is embedded and the nearest passage wins.
 *
 * Embedding rather than word overlap, because the knowledge-search skill tells
 * the model to answer in the USER's language: an English claim about a German
 * page shares almost no words with it. The index's model is multilingual, and
 * every chunk already carries its vector, so this costs one query embedding.
 *
 * The caller decides access. This reads whatever `sourcePaths` it is given, so
 * those must already have passed the same grant check that serves the file.
 */
import { sql } from "drizzle-orm";

import { db } from "@/db";

export interface CitedPassageDeps {
  /** Same contract as `RetrieveDeps.embed`. */
  embed: (texts: string[]) => Promise<number[][]>;
}

interface PassageRow extends Record<string, unknown> {
  chunk_text: string;
}

/**
 * Returns the passage, or null when there is none to show: the page has no
 * indexed text, or it has several and nothing says which (no claim, or no
 * embedder). Null is the honest answer there — a highlight is a statement that
 * the answer came from THIS text, and a guess would make it a false one.
 *
 * `deps` null means the embedder is unavailable; a page with a single passage
 * still answers, because nothing needs ranking.
 */
export async function findCitedPassage(
  orgId: string,
  sourcePaths: string[],
  page: number,
  claim: string | undefined,
  deps: CitedPassageDeps | null
): Promise<{ text: string } | null> {
  if (sourcePaths.length === 0) return null;

  const locator = JSON.stringify({ kind: "page", page });
  const onPage = sql`
    c.org_id = ${orgId}
    AND c.source_path IN (${sql.join(
      sourcePaths.map((path) => sql`${path}`),
      sql`, `
    )})
    AND c.locator @> ${locator}::jsonb`;

  // DISTINCT on the text: one file reached through two granted paths is two
  // documents with the same passages, not a choice between them.
  const candidates = await db.execute<PassageRow>(sql`
    SELECT DISTINCT c.chunk_text FROM kb_chunks c WHERE ${onPage} LIMIT 2`);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { text: candidates[0].chunk_text };

  const trimmed = claim?.trim();
  if (!trimmed || !deps) return null;

  const [vector] = await deps.embed([trimmed]);
  const nearest = await db.execute<PassageRow>(sql`
    SELECT c.chunk_text FROM kb_chunks c
    WHERE ${onPage} AND c.embedding IS NOT NULL
    ORDER BY c.embedding <=> ${JSON.stringify(vector)}::vector
    LIMIT 1`);
  return nearest.length > 0 ? { text: nearest[0].chunk_text } : null;
}
