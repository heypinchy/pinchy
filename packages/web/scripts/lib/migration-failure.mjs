// Diagnostic report for a failed database migration.
//
// Pure formatting, no I/O, so the shape is pinned by a Docker-free unit test
// (src/__tests__/db/migration-failure-report.test.ts) while the runner that
// feeds it is proved against a real Postgres by db-migrate-runner.integration.
//
// Postgres tells us everything we need — which statement, which relation, why —
// and drizzle-kit's bundled `hanji` threw all of it away (see the unit test's
// header for the exact three lines). This turns it back into text.

// postgres.js PostgresError fields worth printing, in the order a reader wants
// them. `message` is rendered in the headline instead. Anything the server did
// not send is skipped rather than printed empty — an empty `hint:` reads like
// "Postgres had no hint", which is a different claim from "we never asked".
const PG_FIELDS = [
  "severity",
  "code",
  "detail",
  "hint",
  "position",
  "where",
  "schema_name",
  "table_name",
  "column_name",
  "constraint_name",
];

// A migrator failure arrives double-wrapped: drizzle throws DrizzleQueryError
// (which carries `.query`, the exact SQL it sent) with the driver's
// PostgresError (which carries the diagnostics) as `.cause`. Both halves are
// needed and neither is on the outer object, so every lookup walks the chain.
function* causeChain(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

/**
 * A postgres.js PostgresError carries `severity`; a connection failure or a
 * plain programmer error does not. Node's fs/net errors have `code` too, so
 * `severity` is the discriminator, not `code`.
 */
function findPostgresError(error) {
  for (const link of causeChain(error)) {
    if ("severity" in link && "code" in link) return link;
  }
  return null;
}

/**
 * The statement drizzle was executing, straight off DrizzleQueryError.
 *
 * Deliberately NOT "the last statement postgres.js sent": the driver issues a
 * `rollback` immediately after the failure, so last-statement tracking reports
 * `rollback` and attributes it to no migration at all.
 */
function findStatement(error) {
  for (const link of causeChain(error)) {
    if (typeof link.query === "string" && link.query.trim()) return link.query;
  }
  return null;
}

function indent(text, pad = "    ") {
  return String(text)
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

/**
 * Find the migration a statement came from.
 *
 * Substring match against the file, not an equality check against a re-split
 * statement list: drizzle splits on `--> statement-breakpoint` and trims, and
 * replicating that split here would be a second implementation to keep in sync
 * for no gain. A DDL statement is distinctive enough that the first file
 * containing it verbatim is the right one.
 *
 * @returns {string | null} the migration tag, or null when nothing matches.
 */
function attributeStatement(statement, migrationFiles) {
  const needle = statement.trim();
  const hit = migrationFiles.find((file) => file.sql.includes(needle));
  return hit ? hit.tag : null;
}

/**
 * Render a migration failure as something a human can act on.
 *
 * @param {object} args
 * @param {unknown} args.error  what the migrator threw
 * @param {{tag: string, sql: string}[]} args.migrationFiles  journal order
 * @returns {string}
 */
export function formatMigrationFailure({ error, migrationFiles = [] }) {
  const lines = ["[db:migrate] migration failed", ""];

  const statement = findStatement(error);
  if (statement) {
    const tag = attributeStatement(statement, migrationFiles);
    lines.push(`  migration: ${tag ? `${tag}.sql` : "unknown (statement matched no migration)"}`);
    lines.push("  statement:");
    lines.push(indent(statement.trim()));
    lines.push("");
  }

  const pgError = findPostgresError(error);
  if (pgError) {
    lines.push(`  PostgresError: ${pgError.message}`);
    for (const field of PG_FIELDS) {
      const value = pgError[field];
      if (value !== undefined && value !== null && value !== "") {
        lines.push(`    ${field}: ${value}`);
      }
    }
  } else if (error instanceof Error) {
    lines.push(`  ${error.name}: ${error.message}`);
    if (error.stack) lines.push(indent(error.stack));
  } else {
    lines.push(`  ${String(error)}`);
  }

  lines.push("");
  lines.push(
    "  Nothing was applied. Drizzle runs every pending migration inside a",
    "  single transaction, so the database is exactly as it was."
  );

  return lines.join("\n");
}
