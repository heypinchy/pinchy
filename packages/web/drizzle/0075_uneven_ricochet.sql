ALTER TABLE "kb_documents" ADD COLUMN "empty_extraction_by" text;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "incomplete_reads" integer DEFAULT 0 NOT NULL;