import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * The statements of a shipped migration file, read off disk.
 *
 * The test DB is migrated before any test runs, so a data migration has
 * already passed over an empty table by then. A test that wants to see it
 * act on rows the old code wrote seeds them and runs the SHIPPED file again —
 * never a copy of its statements, which would stay green about a migration it
 * no longer describes.
 *
 * Split rather than executed in one call: drizzle sends `db.execute` through a
 * prepared statement, and Postgres' extended protocol accepts exactly one
 * command per message. Comment lines go first so a `--` line can never hide the
 * `;` that ends the statement it sits above.
 */
export function migrationStatements(file: string): string[] {
  return readFileSync(join(process.cwd(), "drizzle", file), "utf-8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Runs a shipped migration file's statements against the test DB, in order. */
export async function runMigrationFile(file: string): Promise<void> {
  for (const statement of migrationStatements(file)) {
    await db.execute(sql.raw(statement));
  }
}
