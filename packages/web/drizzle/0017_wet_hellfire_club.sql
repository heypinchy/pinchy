CREATE TABLE "invite_groups" (
	"invite_id" text NOT NULL,
	"group_id" text NOT NULL,
	CONSTRAINT "invite_groups_invite_id_group_id_pk" PRIMARY KEY("invite_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "invite_groups" ADD CONSTRAINT "invite_groups_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_groups" ADD CONSTRAINT "invite_groups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;