CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"vision" boolean,
	"documents" boolean,
	"audio" boolean,
	"video" boolean,
	"long_context" boolean,
	"tools" boolean,
	"source" text NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_models_provider_modelid" ON "models" USING btree ("provider","model_id");
