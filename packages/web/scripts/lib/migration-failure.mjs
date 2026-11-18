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
 * Find the migrations a statement could have come from.
 *
 * Substring match against the file, not an equality check against a re-split
 * statement list: drizzle splits on `--> statement-breakpoint` and trims, and
 * replicating that split here would be a second implementation to keep in sync
 * for no gain.
 *
 * ALL matches are returned, not the first. Migrations do repeat a statement
 * verbatim (`DROP VIEW "public"."active_agents";` is byte-identical in 0016,
 * 0042 and 0045), and naming one of them reads as a fact. The runner narrows
 * the candidate list to the pending migrations first, which usually leaves
 * exactly one; when it does not, saying so beats guessing.
 *
 * @returns {string[]} matching migration tags, in journal order.
 */
function attributeStatement(statement, migrationFiles) {
  const needle = statement.trim();
  return migrationFiles.filter((file) => file.sql.includes(needle)).map((file) => file.tag);
}

/**
 * The database a connection string points at, as `host:port/database`.
 *
 * The failing target is often the whole answer — the bug that prompted this
 * runner was a migration hitting a stale Postgres container on the port the
 * test suite defaults to. But a connection string carries a password, so the
 * URL is never echoed: only `host` (which by definition excludes credentials)
 * and the database name. An unparseable string yields null rather than a
 * best-effort print, because we cannot know which part of it is the secret.
 *
 * @returns {string | null}
 */
export function describeTarget(databaseUrl) {
  if (typeof databaseUrl !== "string") return null;
  try {
    const url = new URL(databaseUrl);
    if (!url.host) return null;
    const database = url.pathname.replace(/^\//, "");
    return database ? `${url.host}/${database}` : url.host;
  } catch {
    return null;
  }
}

/**
 * The journal entries drizzle would still have to apply, given the watermark
 * currently in `drizzle.__drizzle_migrations`.
 *
 * Mirrors drizzle's own boundary (`entry.when > lastRow.created_at`, strictly
 * greater) so statement attribution cannot blame a migration that was applied
 * releases ago. A null watermark means the table does not exist yet: a fresh
 * database, where everything is pending.
 *
 * @template {{when: number|string}} T
 * @param {T[]} entries
 * @param {number|string|null|undefined} watermark
 * @returns {T[]}
 */
export function pendingMigrations(entries, watermark) {
  if (watermark === null || watermark === undefined) return entries;
  return entries.filter((entry) => Number(entry.when) > Number(watermark));
}

/** Render the attribution honestly: none, one, or "these three all contain it". */
function describeAttribution(tags) {
  if (tags.length === 0) return "unknown (statement matched no migration)";
  if (tags.length === 1) return `${tags[0]}.sql`;
  return `${tags[0]}.sql (identical statement also in ${tags.slice(1).join(", ")})`;
}

/** The error's stack with its leading "Name: message" headline removed. */
function stripStackHeadline(error) {
  if (typeof error.stack !== "string") return null;
  const headline = `${error.name}: ${error.message}`;
  const frames = error.stack.startsWith(headline)
    ? error.stack.slice(headline.length)
    : error.stack;
  return frames.trim() ? frames.replace(/^\n/, "") : null;
}

/**
 * Render a migration failure as something a human can act on.
 *
 * @param {object} args
 * @param {unknown} args.error  what the migrator threw
 * @param {{tag: string, sql: string}[]} args.migrationFiles  journal order
 * @param {string | null} [args.target]  from describeTarget(), never a raw URL
 * @returns {string}
 */
export function formatMigrationFailure({ error, migrationFiles = [], target = null }) {
  const lines = ["[db:migrate] migration failed", ""];

  if (target) lines.push(`  target: ${target}`);

  const statement = findStatement(error);
  if (statement) {
    const tags = attributeStatement(statement, migrationFiles);
    lines.push(`  migration: ${describeAttribution(tags)}`);
    lines.push("  statement:");
    lines.push(indent(statement.trim()));
    lines.push("");
  } else if (target) {
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
    // A stack opens by repeating "Name: message" verbatim; strip that prefix so
    // the headline is stated once and the frames still get printed. Matching
    // the prefix rather than slicing the first line keeps multi-line messages
    // intact instead of leaking their tail into the frame list.
    const frames = stripStackHeadline(error);
    if (frames) lines.push(indent(frames));
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
