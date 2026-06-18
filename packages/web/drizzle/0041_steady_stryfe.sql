CREATE TABLE "chat_session_errors" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_key" text NOT NULL,
	"client_message_id" text,
	"run_id" text,
	"agent_name" text NOT NULL,
	"model" text,
	"error_class" text NOT NULL,
	"transient_reason" text,
	"provider_error" text NOT NULL,
	"side_effects" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"superseded_at" timestamp,
	"dismissed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "chat_session_errors" ADD CONSTRAINT "chat_session_errors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_session_errors" ADD CONSTRAINT "chat_session_errors_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_session_errors_session" ON "chat_session_errors" USING btree ("session_key","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_session_errors_gc" ON "chat_session_errors" USING btree ("created_at");