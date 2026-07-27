-- IF NOT EXISTS is load-bearing, not defensive habit. The 0.9 release branch
-- backported this table (#905/#894) as its own migration
-- 0056_openai_compatible_providers, numbered and timestamped to sit BELOW
-- 0056_serious_expediter so a 0.9.0 database's drizzle watermark stays under
-- every 0.10 migration and the upgrade still applies 0056-0058 in order. The
-- cost of that ordering is that a 0.9.0 database reaches this migration with
-- the table already created, and a plain CREATE TABLE would abort the whole
-- 0.9.0 -> 0.10 upgrade. The DDL below is byte-identical to what the release
-- branch ran, so skipping it there is correct rather than merely tolerable.
--
-- Do not regenerate this file with `db:generate` without re-adding the guard.
-- migration-090-upgrade-path.integration.test.ts fails if it goes missing.
CREATE TABLE IF NOT EXISTS "openai_compatible_providers" (
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
