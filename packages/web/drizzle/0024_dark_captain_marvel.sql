ALTER TABLE "audit_log" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "error" jsonb;--> statement-breakpoint
CREATE INDEX "idx_audit_outcome" ON "audit_log" USING btree ("outcome");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_v2_outcome_required"
  CHECK ("version" = 1 OR "outcome" IS NOT NULL);