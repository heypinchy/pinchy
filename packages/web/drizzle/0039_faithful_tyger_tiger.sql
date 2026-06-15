ALTER TABLE "usage_records" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "seq" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_session_run" ON "usage_records" USING btree ("session_key","run_id");