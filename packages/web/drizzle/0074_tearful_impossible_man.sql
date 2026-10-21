ALTER TABLE "kb_index_jobs" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_index_jobs" ADD COLUMN "sweep_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_index_jobs" ADD COLUMN "unavailable_folders" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_index_jobs" ADD CONSTRAINT "kb_index_jobs_trigger_check" CHECK ("kb_index_jobs"."trigger" IN ('manual', 'scheduled'));