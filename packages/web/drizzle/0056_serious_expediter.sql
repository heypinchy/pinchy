-- Switch the knowledge-base embedder from bge-m3 (1024-dim, over Ollama) to the
-- in-process native embeddinggemma-300m (768-dim). See #715.
--
-- This is necessarily DESTRUCTIVE. A different embedding model produces vectors
-- that are not comparable to the old ones, and pgvector cannot change a vector
-- column's width in place, so the old embeddings cannot be kept OR converted —
-- they must be dropped and every chunk re-embedded. kb_chunks and kb_documents
-- are 100% derived from the source PDFs on disk, so truncating them loses
-- nothing that a reindex cannot rebuild. After this migration the KB is empty
-- until an admin triggers a reindex (the source files are untouched).
--
-- Steps: drop the HNSW index (it depends on the column), truncate the derived
-- rows, drop + re-add the embedding column at the new width (DROP/ADD avoids any
-- 1024->768 cast pgvector does not provide), then recreate the HNSW index.
DROP INDEX IF EXISTS "idx_kb_chunks_embedding";--> statement-breakpoint
TRUNCATE TABLE "kb_chunks", "kb_documents";--> statement-breakpoint
ALTER TABLE "kb_chunks" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "embedding" vector(768);--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_embedding" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);
