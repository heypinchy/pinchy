CREATE TABLE "email_connection_cursors" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_workflow_connections" (
	"workflow_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"since_ts" timestamp NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_workflow_connections_workflow_id_connection_id_pk" PRIMARY KEY("workflow_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "email_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"action" text NOT NULL,
	"poll_every" text DEFAULT '5m' NOT NULL,
	"sweep_window_days" integer DEFAULT 14 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"openclaw_job_id" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"message_id_header" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"outcome" jsonb,
	"run_id" text,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	"finalized_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "email_connection_cursors" ADD CONSTRAINT "email_connection_cursors_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_workflow_connections" ADD CONSTRAINT "email_workflow_connections_workflow_id_email_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."email_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_workflow_connections" ADD CONSTRAINT "email_workflow_connections_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_workflows" ADD CONSTRAINT "email_workflows_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_workflows" ADD CONSTRAINT "email_workflows_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD CONSTRAINT "processed_emails_workflow_id_email_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."email_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_workflows_agent_idx" ON "email_workflows" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "email_workflows_enabled_idx" ON "email_workflows" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_emails_claim_uniq" ON "processed_emails" USING btree ("workflow_id","connection_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "processed_emails_status_idx" ON "processed_emails" USING btree ("status");