CREATE TABLE "channel_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"channel_user_id" text NOT NULL,
	"linked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_links_user_id_idx" ON "channel_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channel_links_channel_user_idx" ON "channel_links" USING btree ("channel","channel_user_id");