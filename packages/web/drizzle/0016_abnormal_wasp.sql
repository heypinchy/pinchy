CREATE TABLE "agent_groups" (
	"agent_id" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "agent_groups_agent_id_group_id_pk" PRIMARY KEY("agent_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"user_id" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "user_groups_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
DROP VIEW "public"."active_agents";--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'member';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "visibility" text DEFAULT 'admin_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD CONSTRAINT "agent_groups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_groups" ADD CONSTRAINT "agent_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_groups" ADD CONSTRAINT "user_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE VIEW "public"."active_agents" AS (select "id", "name", "model", "template_id", "plugin_config", "allowed_tools", "owner_id", "is_personal", "visibility", "greeting_message", "tagline", "avatar_seed", "personality_preset_id", "created_at", "deleted_at" from "agents" where "agents"."deleted_at" is null);--> statement-breakpoint

-- Data migration: rename existing 'user' roles to 'member'
UPDATE "user" SET "role" = 'member' WHERE "role" = 'user';
UPDATE "invites" SET "role" = 'member' WHERE "role" = 'user';

-- Data migration: existing shared agents should remain visible to all
UPDATE "agents" SET "visibility" = 'all' WHERE "is_personal" = false;