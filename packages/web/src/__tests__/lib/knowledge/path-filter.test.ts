/**
 * `escapeLikePattern` (packages/web/src/lib/knowledge/path-filter.ts) is a
 * "security-relevant boundary bypass" guard per its own doc comment: without
 * it, an allowed path containing a literal `_` or `%` — both real Postgres
 * LIKE metacharacters, and `_` is common in real folder names like
 * "my_folder" — would silently widen an agent's allow-listed knowledge-base
 * path into a wildcard, letting the agent read documents outside its grant.
 * Nothing exercised this before: retrieve.integration.test.ts covers
 * prefix-bleed and deny-by-default, but no allowed path containing `_`, `%`,
 * or `\`.
 *
 * `escapeLikePattern` is a private, unexported implementation detail of
 * buildPathFilter(), and stays that way — the question worth asking is not
 * what that function returns but what Postgres is finally asked to match. So
 * these tests compile buildPathFilter()'s `SQL` with drizzle's own
 * `PgDialect.sqlToQuery()` — the public API the driver itself calls on the
 * way to the wire — and assert the resulting `{ sql, params }`: the
 * parameterized query text and the exact bytes bound into it.
 *
 * Reading the compiled query rather than the `SQL` object's internal
 * `queryChunks` is what lets the ESCAPE-clause test below exist at all: the
 * clause is query TEXT, not a parameter, so no assertion on the pattern
 * string can see it.
 *
 * Mutation evidence, measured while writing this file (nothing committed —
 * `git diff` on path-filter.ts is empty):
 *
 *   - `escapeLikePattern` reduced to `return value`: 6 of 10 red. Listing the
 *     four survivors is the honest half of this note — they are the two that
 *     assert an ABSENCE of escaping (the plain-path case and the `=`-operand
 *     case), the determinism check, and the compiled-predicate check. None of
 *     them depends on a metacharacter being rewritten, so "every test goes
 *     red" would be a claim this file does not support.
 *   - the `.replace()` calls reordered so `%`/`_` are escaped before `\`:
 *     5 of 10 red. The one metacharacter case that survives is the
 *     backslash-only path, which contains no `%` or `_` for the reordering to
 *     act on — every other metacharacter case comes out with the backslash
 *     doubled around a now-unescaped wildcard.
 *   - `ESCAPE '\\'` changed to `ESCAPE '!'` in path-filter.ts: 2 red, and
 *     both are the tests that read the compiled query TEXT. Every assertion
 *     on a bound pattern stays green and byte-identical while Postgres reads
 *     the emitted `\_` as two literal characters and the wildcard is back.
 *     That mutant is the reason this file compiles the query instead of
 *     inspecting the escaping in isolation.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { buildPathFilter } from "@/lib/knowledge/path-filter";

const COLUMN = sql`c.source_path`;

/**
 * Compiles buildPathFilter()'s fragment the way the pg driver does, yielding
 * the parameterized SQL text plus the ordered parameter values. Per allowed
 * path the template binds two, in this order: the `=` operand (the raw
 * allowed path) and then the LIKE pattern (escaped, with the trailing `%`).
 */
function compile(allowedPaths: readonly string[]): { text: string; params: unknown[] } {
  const { sql: text, params } = new PgDialect().sqlToQuery(buildPathFilter(allowedPaths, COLUMN));
  return { text, params };
}

/** The LIKE pattern buildPathFilter() binds for a single allowed path. */
function likePatternFor(allowedPath: string): string {
  const { params } = compile([allowedPath]);
  expect(params).toHaveLength(2);
  const pattern = params[1];
  expect(typeof pattern).toBe("string");
  return pattern as string;
}

describe("buildPathFilter — LIKE pattern escaping (escapeLikePattern boundary)", () => {
  it("escapes a literal underscore so it is not read as a single-character wildcard", () => {
    // Unescaped, `/data/my_folder/%` as a LIKE pattern would ALSO match
    // "/data/myXfolder/…" for any X — exactly the bypass this guards against.
    expect(likePatternFor("/data/my_folder")).toBe("/data/my\\_folder/%");
  });

  it("escapes a literal percent sign so it is not read as a multi-character wildcard", () => {
    // Unescaped, `%` in the allowed path would make the LIKE pattern match
    // an arbitrary run of characters at that position.
    expect(likePatternFor("/data/50%off")).toBe("/data/50\\%off/%");
  });

  it("escapes a literal backslash by doubling it, so it is not read as an escape character itself", () => {
    // Input path contains one literal backslash: /data/foo\bar
    expect(likePatternFor("/data/foo\\bar")).toBe("/data/foo\\\\bar/%");
  });

  it("escapes backslash, percent, and underscore together in one path", () => {
    // Input: /data/50%_off\thing
    expect(likePatternFor("/data/50%_off\\thing")).toBe("/data/50\\%\\_off\\\\thing/%");
  });

  it("escapes backslash BEFORE percent/underscore, so a literal backslash immediately followed by an underscore does not collapse into an unescaped wildcard", () => {
    // Order matters here. Input: /data/foo\_bar (one literal backslash, then
    // an underscore). escapeLikePattern must escape the backslash first
    // (\ -> \\), THEN escape the underscore (_ -> \_) on the ALREADY-escaped
    // string — giving three backslashes then the underscore: \\\_.
    //
    // If the implementation instead escaped `_` before `\` (the wrong
    // order), the underscore would become `\_` first and the subsequent
    // backslash-escaping step would double BOTH backslashes in that pair,
    // producing `\\\\_` (four backslashes) instead of `\\\_` (three) — a
    // different but still-technically-escaped string, so this case is a
    // weaker way to catch an order bug than the raw wildcard bypass tests
    // above. It's included anyway because it pins the exact algorithm the
    // code comment promises (escape `\\` first).
    expect(likePatternFor("/data/foo\\_bar")).toBe("/data/foo\\\\\\_bar/%");
  });

  it("does not escape a path with no LIKE metacharacters (no spurious backslashes)", () => {
    expect(likePatternFor("/data/plain-folder")).toBe("/data/plain-folder/%");
  });

  it("is deterministic: the same allowed path always produces the same escaped LIKE pattern", () => {
    const first = likePatternFor("/data/my_folder");
    const second = likePatternFor("/data/my_folder");
    expect(second).toBe(first);
  });

  it("compiles to an equality-or-prefix predicate that declares backslash as the LIKE ESCAPE character", () => {
    // Two things no assertion on a bound parameter can reach.
    //
    // The ESCAPE character: it is what makes the emitted `\_` an escaped
    // literal underscore rather than two characters. Change it to anything
    // else and every pattern assertion in this file is still byte-identical
    // and still green, while Postgres reads the `_` as a wildcard again.
    // (Backslash also happens to be Postgres's default, so DROPPING the
    // clause is harmless — replacing it is not, and that is the mutant.)
    //
    // The parameter order: the tests above read params[1] as the LIKE
    // pattern and params[0] as the `=` operand. This is where that reading
    // is pinned, so a restructured predicate fails here by name instead of
    // making the others quietly compare the wrong operand.
    expect(compile(["/data/my_folder"]).text).toBe(
      "(c.source_path = $1 OR c.source_path LIKE $2 ESCAPE '\\')"
    );
  });

  it("escapes each allowed path independently when buildPathFilter is given several", () => {
    const { text, params } = compile(["/data/my_folder", "/data/50%off"]);

    expect(text).toBe(
      "(c.source_path = $1 OR c.source_path LIKE $2 ESCAPE '\\') OR " +
        "(c.source_path = $3 OR c.source_path LIKE $4 ESCAPE '\\')"
    );
    expect(params).toEqual([
      "/data/my_folder",
      "/data/my\\_folder/%",
      "/data/50%off",
      "/data/50\\%off/%",
    ]);
  });

  it("does NOT escape the exact-match (=) operand — escaping is scoped to the LIKE pattern only", () => {
    // The `=` branch compares the raw allowedPath directly (not a LIKE
    // pattern), so it must never be touched by escapeLikePattern. A mutant
    // that escaped everywhere (not just the prefix pattern) would break an
    // agent whose allowedPaths entry is an exact file path containing `_`
    // or `%` — it would stop matching itself.
    expect(compile(["/data/my_folder"]).params[0]).toBe("/data/my_folder");
  });
});
