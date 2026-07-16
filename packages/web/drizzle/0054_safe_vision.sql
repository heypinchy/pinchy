-- Hand-authored: enable the pgvector extension BEFORE the kb_chunks table
-- below, whose `embedding vector(1024)` column needs the `vector` type to
-- exist. drizzle-kit's schema diff cannot express `CREATE EXTENSION`, so it
-- is prepended here. Idempotent (IF NOT EXISTS) so re-running against a DB
-- that already has it is a no-op. The db image is pgvector/pgvector:pg17-trixie
-- (see docker-compose.yml), which ships the extension's shared library.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"org_id" text NOT NULL,
	"source_path" text NOT NULL,
	"chunk_text" text NOT NULL,
	"page" integer,
	"lang" text,
	"embedding" vector(1024)
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"source_path" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"lang" text,
	"page_count" integer,
	"mtime" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_doc" ON "kb_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_org_path" ON "kb_chunks" USING btree ("org_id","source_path");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_doc_org_path" ON "kb_documents" USING btree ("org_id","source_path");--> statement-breakpoint
CREATE INDEX "idx_kb_doc_org_hash" ON "kb_documents" USING btree ("org_id","content_hash");--> statement-breakpoint
-- Hand-authored: drizzle-kit's schema diff cannot express HNSW vector
-- indexes, FTS generated columns, or GIN indexes. vector_cosine_ops matches
-- retrieval's `<=>` cosine-distance operator. The tsv column uses the
-- language-agnostic 'simple' config (no stemmer) to match the multilingual
-- cross-lingual DE/EN retrieval design.
CREATE INDEX "idx_kb_chunks_embedding" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "chunk_text")) STORED;--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_tsv" ON "kb_chunks" USING gin ("tsv");