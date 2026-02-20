CREATE TABLE "agent_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"role" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "plugin_config" jsonb;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;