CREATE TABLE "agent_delivered_files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_delivered_files" ADD CONSTRAINT "agent_delivered_files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_delivered_files" ADD CONSTRAINT "agent_delivered_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_delivered_files_lookup" ON "agent_delivered_files" USING btree ("agent_id","filename","user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_delivered_files_session" ON "agent_delivered_files" USING btree ("session_key");