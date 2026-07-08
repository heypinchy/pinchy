CREATE TABLE "audit_verify_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_verified_id" integer DEFAULT 0 NOT NULL,
	"last_verified_hmac" text,
	"last_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
