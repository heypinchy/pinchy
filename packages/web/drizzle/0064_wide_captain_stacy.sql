ALTER TABLE "chat_session_errors" ADD COLUMN "run_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat_session_errors" ADD COLUMN "show_banner" boolean DEFAULT true NOT NULL;