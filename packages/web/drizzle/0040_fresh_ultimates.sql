CREATE TABLE "channel_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"channel" text NOT NULL,
	"peer_id" text NOT NULL,
	"direction" text NOT NULL,
	"external_id" text NOT NULL,
	"content" text NOT NULL,
	"sent_at" timestamp NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_messages_agent_channel_peer_idx" ON "channel_messages" USING btree ("agent_id","channel","peer_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_dedup_uniq" ON "channel_messages" USING btree ("channel","agent_id","peer_id","direction","external_id");