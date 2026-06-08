-- Forward repair migration for the `uploaded_files` table.
--
-- Background: `0035_smart_misty_knight` originally carried an out-of-order
-- `when` timestamp (corrected in PR #468). drizzle's migrator gates on
-- `when > max(created_at already applied)` and reads that max once, so any
-- database that applied the later `0036_models_table` before 0035 stranded
-- 0035 permanently — correcting its timestamp can't bring it back, because the
-- corrected value is still below 0036's. Such databases (e.g. `:next`-tracking
-- staging) were left without `uploaded_files`, 500-ing every file upload.
--
-- This migration's timestamp is greater than every prior entry, so the migrator
-- always runs it. It is fully idempotent: on a healthy database (0035 applied)
-- every statement is a no-op; on a gap-victim database it creates the missing
-- table, foreign keys, and indexes — an exact rebuild of 0035's schema. It must
-- stay equivalent to 0035 so both paths converge on one schema.
CREATE TABLE IF NOT EXISTS "uploaded_files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"staging_path" text,
	"expires_at" timestamp,
	"message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"attached_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'uploaded_files_user_id_user_id_fk'
		  AND conrelid = 'public.uploaded_files'::regclass
	) THEN
		ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'uploaded_files_agent_id_agents_id_fk'
		  AND conrelid = 'public.uploaded_files'::regclass
	) THEN
		ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploaded_files_gc" ON "uploaded_files" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_uploaded_files_user_agent_draft" ON "uploaded_files" USING btree ("user_id","agent_id","draft_id");
