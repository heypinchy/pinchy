CREATE TABLE "briefing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"briefing_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"openclaw_job_id" text NOT NULL,
	"openclaw_run_id" text NOT NULL,
	"openclaw_session_key" text NOT NULL,
	"run_at_ms" bigint NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"notification_processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"last_run_status" text,
	"last_synced_at" timestamp,
	"sync_error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_recipients" (
	"user_id" text NOT NULL,
	"notification_id" uuid NOT NULL,
	"delivered_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp,
	CONSTRAINT "notification_recipients_user_id_notification_id_pk" PRIMARY KEY("user_id","notification_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"briefing_run_id" uuid,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "briefing_runs" ADD CONSTRAINT "briefing_runs_briefing_id_briefings_id_fk" FOREIGN KEY ("briefing_id") REFERENCES "public"."briefings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_runs" ADD CONSTRAINT "briefing_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_briefing_run_id_briefing_runs_id_fk" FOREIGN KEY ("briefing_run_id") REFERENCES "public"."briefing_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "briefing_runs_openclaw_run_id_uniq" ON "briefing_runs" USING btree ("openclaw_run_id");--> statement-breakpoint
CREATE INDEX "briefing_runs_briefing_run_at_idx" ON "briefing_runs" USING btree ("briefing_id","run_at_ms");--> statement-breakpoint
CREATE INDEX "briefing_runs_session_key_idx" ON "briefing_runs" USING btree ("openclaw_session_key");--> statement-breakpoint
CREATE INDEX "briefings_agent_id_idx" ON "briefings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "briefings_enabled_idx" ON "briefings" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "notification_recipients_user_unread_idx" ON "notification_recipients" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_agent_created_idx" ON "notifications" USING btree ("agent_id","created_at");