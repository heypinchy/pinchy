-- Backport of #905 (#894) to the 0.9 release branch. The SQL is byte-identical
-- to main's 0059_right_speedball, but the migration is deliberately numbered
-- 0056 here with `when` = 1784300000000 — between 0055 (1784286855381) and
-- main's 0056_serious_expediter (1784536753112).
--
-- Why the number and the timestamp matter: drizzle's migrator is gated on a
-- single high-water mark (`select ... order by created_at desc limit 1`, then
-- apply only where `when` exceeds it). Shipping this as 0059 on a branch that
-- has none of 0056-0058 would raise every 0.9.0 database's watermark above the
-- KB embedder switch, the KB archive backfill and agent_delivered_files, so the
-- 0.9.0 -> 0.10 upgrade would skip all three FOREVER — the exact failure mode
-- 0035_smart_misty_knight shipped and migration-journal-order now guards.
--
-- The counterpart on main is that 0059_right_speedball creates this table with
-- IF NOT EXISTS, so it is a no-op on a database that already got it from here.
CREATE TABLE "openai_compatible_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openai_compatible_providers_slug_unique" UNIQUE("slug")
);
