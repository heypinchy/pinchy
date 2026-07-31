/**
 * Seeds the synthetic KB corpus into a running stack's Postgres.
 *
 * Extracted from `kb-eval-models.spec.ts` so it can be exercised against a
 * real database by a test, the same move `chunk-texts.ts` made and for the
 * same reason: a spec imports `@playwright/test`, so nothing in the vitest
 * suite could reach this code, and the sweep is the only caller — a sweep
 * that had never run. Both defects it shipped with were invisible to review
 * and to a full green suite, and both are schema-level, so only a real
 * Postgres could have caught them.
 *
 * Uses the COMMITTED embeddinggemma-300m fixture (`./embeddings-fixture.ts`) — the
 * same one Layer 1's `kb-retrieval-eval.integration.test.ts` uses — so corpus
 * ingestion needs no live embedder. The real `retrieve()` still embeds the
 * QUERY at search time; that dependency is unchanged.
 *
 * `orgId` MUST be `DEFAULT_ORG_ID` ("default"): the real search route
 * hardcodes that single-tenant seam (`src/lib/knowledge/constants.ts`),
 * unlike the Layer-1 vitest suite's isolated `"org-kb-eval"` constant.
 */

import { DEFAULT_ORG_ID } from "../../src/lib/knowledge/constants";
import { statusForPath } from "../../src/lib/knowledge/archive-paths";
import { KB_EVAL_CORPUS } from "./corpus/manifest";
import { loadEmbeddings } from "./embeddings-fixture";

export async function seedSyntheticCorpus(dbUrl: string): Promise<void> {
  const embeddings = loadEmbeddings();
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl);
  try {
    for (const doc of KB_EVAL_CORPUS) {
      // kb_documents.id / kb_chunks.id are `text` with NO database default —
      // the app supplies them via Drizzle's `$defaultFn(() => crypto.randomUUID())`,
      // so a raw INSERT that omits `id` hits a NOT NULL violation. Mint one in
      // SQL (gen_random_uuid() is built into Postgres 13+, no extension) to
      // mirror the app's uuid-shaped text id.
      //
      // `status` comes from the real archive rule, never a hard-coded
      // 'active': the freshness axis (#858) exists precisely to check that an
      // `OLD/` copy stays out of default retrieval, and seeding it active
      // would have the sweep grade the opposite of what the axis asks.
      //
      // DO UPDATE rather than DO NOTHING, on the `uq_kb_doc_org_path` unique
      // key, for two reasons. It always RETURNs the id, so a resumed sweep
      // needs no separate re-select. And it re-derives the status of a row an
      // earlier run left behind — the crash this seeder shipped with stopped
      // mid-document and left exactly such a row. Re-deriving is safe because
      // the status is a pure function of the path.
      const [dbDoc] = await sql<{ id: string }[]>`
        INSERT INTO kb_documents (id, org_id, content_hash, source_path, status)
        VALUES (
          gen_random_uuid()::text, ${DEFAULT_ORG_ID}, ${`hash-${doc.sourcePath}`},
          ${doc.sourcePath}, ${statusForPath(doc.sourcePath)}
        )
        ON CONFLICT (org_id, source_path)
        DO UPDATE SET status = EXCLUDED.status
        RETURNING id
      `;
      const dbDocId = dbDoc?.id;
      if (!dbDocId) throw new Error(`Failed to resolve kb_documents.id for ${doc.sourcePath}`);

      for (const chunk of doc.chunks) {
        const embedding = embeddings.chunks[chunk.id];
        if (!embedding) {
          throw new Error(
            `Missing embedding fixture for chunk id ${chunk.id} — run pnpm kb-eval:reembed`
          );
        }
        const existing = await sql<{ id: string }[]>`
          SELECT id FROM kb_chunks WHERE document_id = ${dbDocId} AND chunk_text = ${chunk.text}
        `;
        if (existing.length > 0) continue; // already seeded by a prior invocation
        // Two literal casts, two different reasons. pgvector's textual form is
        // the same `[1,2,3]` JSON.stringify produces for a number array (see
        // retrieve.ts's identical `::vector` pattern). `locator` is a jsonb
        // COLUMN — there is no `page` column and never was; the union it
        // stores (page / slide / heading / sheet-range) is what makes a
        // citation checkable, so it is the shape the app writes and the shape
        // the sweep must write too.
        await sql`
          INSERT INTO kb_chunks (id, document_id, org_id, source_path, chunk_text, locator, embedding)
          VALUES (
            gen_random_uuid()::text, ${dbDocId}, ${DEFAULT_ORG_ID}, ${doc.sourcePath},
            ${chunk.text}, ${JSON.stringify({ kind: "page", page: chunk.page })}::jsonb,
            ${JSON.stringify(embedding)}::vector
          )
        `;
      }
    }
  } finally {
    await sql.end();
  }
}
