CREATE TABLE "uploaded_files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"staging_path" text,
	"expires_at" timestamp,
	"message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"attached_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_uploaded_files_gc" ON "uploaded_files" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_uploaded_files_user_agent_draft" ON "uploaded_files" USING btree ("user_id","agent_id","draft_id");