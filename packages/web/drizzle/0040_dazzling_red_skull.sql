CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'consumed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."approval_tier" AS ENUM('confirm', 'escalate');--> statement-breakpoint
CREATE TABLE "tool_approval" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"session_key" text NOT NULL,
	"tool_name" text NOT NULL,
	"args_digest" text NOT NULL,
	"args_summary" jsonb,
	"tier" "approval_tier" DEFAULT 'confirm' NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"approver_id" text,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_approval" ADD CONSTRAINT "tool_approval_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval" ADD CONSTRAINT "tool_approval_requester_id_user_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval" ADD CONSTRAINT "tool_approval_approver_id_user_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_approval_lookup_idx" ON "tool_approval" USING btree ("agent_id","requester_id","args_digest","status");--> statement-breakpoint
CREATE INDEX "tool_approval_requester_status_idx" ON "tool_approval" USING btree ("requester_id","status");