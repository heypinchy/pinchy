/**
 * The knowledge base's path allow-list, as a SQL predicate.
 *
 * Every read that answers "what does this agent know about?" — retrieval
 * (./retrieve.ts) and the unsearchable-document list (./unsearchable.ts) — is
 * scoped by the SAME admin-configured `allowed_paths` grants, so the rule that
 * decides what is inside a grant lives once. Two copies of a boundary check are
 * two chances to fix only one of them.
 */
import { sql, type SQL } from "drizzle-orm";
import { sep } from "node:path";

/**
 * Escapes Postgres LIKE metacharacters (`\`, `%`, `_`) in a path segment
 * before it's used as a LIKE prefix pattern. Without this, an allowed path
 * that happens to contain a literal `_` (a single-character LIKE wildcard,
 * common in real folder names like "my_folder") would silently widen the
 * match to unrelated paths — a security-relevant boundary bypass.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Builds the WHERE fragment scoping a query to `allowedPaths`. A row qualifies
 * iff `column` equals an allowed path exactly, or sits under an allowed
 * directory. The path separator is appended to the allowed path before
 * prefix-matching so "/data/foo" never matches "/data/foobar/x.pdf" — the same
 * boundary reasoning as ingest.ts's removal pass.
 *
 * `column` is a caller-supplied SQL fragment (e.g. sql`c.source_path`) rather
 * than a string, so the alias in play at the call site stays with the query
 * that owns it. Callers must handle an EMPTY `allowedPaths` list themselves,
 * by denying: this returns an empty fragment, which as a WHERE clause would
 * mean "no restriction".
 */
export function buildPathFilter(allowedPaths: readonly string[], column: SQL): SQL {
  const conditions = allowedPaths.map((allowedPath) => {
    const prefix = allowedPath.endsWith(sep) ? allowedPath : allowedPath + sep;
    const likePattern = `${escapeLikePattern(prefix)}%`;
    return sql`(${column} = ${allowedPath} OR ${column} LIKE ${likePattern} ESCAPE '\\')`;
  });
  return sql.join(conditions, sql` OR `);
}
