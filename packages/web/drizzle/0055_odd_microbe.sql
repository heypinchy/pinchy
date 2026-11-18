CREATE TABLE "kb_index_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"requested_by" text NOT NULL,
	"paths" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total" integer,
	"processed" integer DEFAULT 0 NOT NULL,
	"counts" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	CONSTRAINT "kb_index_jobs_status_check" CHECK ("kb_index_jobs"."status" IN ('pending', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "kb_index_jobs" ADD CONSTRAINT "kb_index_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_index_jobs_active" ON "kb_index_jobs" USING btree ("org_id") WHERE "kb_index_jobs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_kb_index_jobs_status_created" ON "kb_index_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_kb_index_jobs_agent_created" ON "kb_index_jobs" USING btree ("agent_id","created_at");