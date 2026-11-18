ALTER TABLE "kb_index_jobs" ADD COLUMN "total_bytes" bigint;--> statement-breakpoint
ALTER TABLE "kb_index_jobs" ADD COLUMN "processed_bytes" bigint DEFAULT 0 NOT NULL;