CREATE TABLE "usage_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"session_key" text NOT NULL,
	"model" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(10, 6)
);
--> statement-breakpoint
CREATE INDEX "idx_usage_timestamp" ON "usage_records" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_usage_user" ON "usage_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_usage_agent" ON "usage_records" USING btree ("agent_id");