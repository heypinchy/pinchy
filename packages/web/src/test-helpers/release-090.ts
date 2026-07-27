/**
 * Facts about the released v0.9.0 database, shared by the static guard
 * (src/__tests__/db/migration-090-baseline.test.ts) and the behavioral one
 * (src/__tests__/db/migration-090-upgrade-path.integration.test.ts).
 *
 * These are historical constants, not configuration. They describe a branch
 * that has already shipped (`release/0.9`); editing them here changes nothing
 * about what customers run, it only makes both guards describe a database that
 * does not exist. They live in one module so the two guards cannot drift apart.
 */

/** Last migration idx that shipped in v0.9.0. 0056-0059 are the 0.10 additions. */
export const V090_LAST_IDX = 55;
export const V090_LAST_TAG = "0055_odd_microbe";

/**
 * release/0.9 backported #905/#894 as its own migration, numbered and
 * timestamped to sit BETWEEN 0055 (1784286855381) and main's
 * 0056_serious_expediter (1784536753112), so a 0.9.0 database's drizzle
 * watermark stays below every 0.10 migration. See the header of
 * drizzle/0059_right_speedball.sql for why that ordering is load-bearing.
 */
export const REL09_TAG = "0056_openai_compatible_providers";
export const REL09_WHEN = 1784300000000;

/** The table the backport creates, and that 0059 must re-create idempotently. */
export const PROVIDER_TABLE = "openai_compatible_providers";

/** main's migration for the same table. */
export const PROVIDER_MIGRATION_TAG = "0059_right_speedball";

/**
 * The DDL release/0.9 actually ran — main's 0059 without the IF NOT EXISTS
 * guard, which on a 0.9.0 database has nothing to guard against. Mirrored
 * rather than derived from 0059 so that an edit to 0059 is reported instead of
 * silently followed; migration-090-baseline.test.ts pins the two together.
 */
export const REL09_SQL = `CREATE TABLE "openai_compatible_providers" (
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
`;
