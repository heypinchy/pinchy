CREATE TABLE "audit_verify_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_verified_id" integer DEFAULT 0 NOT NULL,
	"last_verified_hmac" text,
	"last_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "audit_pseudonym" text;--> statement-breakpoint
-- Backfill existing rows BEFORE the NOT NULL/UNIQUE constraints are added:
-- gen_random_uuid() gives every pre-existing user a pseudonym so the
-- following ALTERs don't fail against a non-empty "user" table on upgrade.
UPDATE "user" SET "audit_pseudonym" = gen_random_uuid()::text WHERE "audit_pseudonym" IS NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "audit_pseudonym" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_audit_pseudonym_unique" UNIQUE("audit_pseudonym");