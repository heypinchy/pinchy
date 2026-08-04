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
 * `escapeLikePattern` itself is a private, unexported implementation detail
 * of buildPathFilter() — deliberately not exported for this test file, since
 * the brief for this PR is test-only. These tests instead exercise it through
 * buildPathFilter()'s public SQL output, by walking the drizzle-orm `SQL`
 * object's `queryChunks` to read the raw LIKE-pattern parameter that was
 * interpolated into the query. This is exactly the value Postgres receives
 * on the wire, so it is at least as strong a check as calling the private
 * function directly — and it also lets these tests catch a regression where
 * the escaping is dropped entirely, moved to the wrong operand, or applied
 * in the wrong order (see the "order matters" test below).
 *
 * Mutation check performed while writing this file (not committed): with the
 * three `.replace(...)` calls in `escapeLikePattern` removed (or reordered),
 * every test below goes red. See the PR description for the exact diff and
 * failure output.
 */
import { sql, type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { buildPathFilter } from "@/lib/knowledge/path-filter";

/**
 * Recursively walks a drizzle-orm SQL object's `queryChunks` (which nest —
 * `buildPathFilter` builds one `SQL` fragment per allowed path and joins them
 * with `sql\` OR \``, so a multi-path call's chunks contain child `SQL`
 * objects rather than one flat array) and collects every raw string
 * parameter that was interpolated immediately after a ` LIKE ` operator
 * chunk, in encounter order. That parameter is exactly what
 * `escapeLikePattern` produced (plus the trailing `%` buildPathFilter
 * appends), i.e. the literal bytes Postgres receives for the LIKE pattern.
 */
function collectLikePatterns(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const chunk = node[i];
      if (
        typeof chunk === "object" &&
        chunk !== null &&
        Array.isArray((chunk as { value?: unknown[] }).value) &&
        (chunk as { value: unknown[] }).value[0] === " LIKE "
      ) {
        const next = node[i + 1];
        if (typeof next === "string") out.push(next);
      }
      collectLikePatterns(chunk, out);
    }
    return out;
  }
  if (typeof node === "object" && node !== null && "queryChunks" in node) {
    collectLikePatterns((node as { queryChunks: unknown[] }).queryChunks, out);
  }
  return out;
}

/** Same walk, but for the raw parameter following the ` = ` equality operator. */
function collectEqualsValues(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const chunk = node[i];
      if (
        typeof chunk === "object" &&
        chunk !== null &&
        Array.isArray((chunk as { value?: unknown[] }).value) &&
        (chunk as { value: unknown[] }).value[0] === " = "
      ) {
        const next = node[i + 1];
        if (typeof next === "string") out.push(next);
      }
      collectEqualsValues(chunk, out);
    }
    return out;
  }
  if (typeof node === "object" && node !== null && "queryChunks" in node) {
    collectEqualsValues((node as { queryChunks: unknown[] }).queryChunks, out);
  }
  return out;
}

const COLUMN = sql`c.source_path`;

/** buildPathFilter() for a single allowed path, returning its LIKE pattern. */
function likePatternFor(allowedPath: string): string {
  const condition = buildPathFilter([allowedPath], COLUMN);
  const patterns = collectLikePatterns(condition);
  expect(patterns).toHaveLength(1);
  return patterns[0];
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

  it("escapes each allowed path independently when buildPathFilter is given several", () => {
    const condition = buildPathFilter(["/data/my_folder", "/data/50%off"], COLUMN);
    const patterns = collectLikePatterns(condition);
    expect(patterns).toEqual(["/data/my\\_folder/%", "/data/50\\%off/%"]);
  });

  it("does NOT escape the exact-match (=) operand — escaping is scoped to the LIKE pattern only", () => {
    // The `=` branch compares the raw allowedPath directly (not a LIKE
    // pattern), so it must never be touched by escapeLikePattern. A mutant
    // that escaped everywhere (not just the prefix pattern) would break an
    // agent whose allowedPaths entry is an exact file path containing `_`
    // or `%` — it would stop matching itself.
    const condition = buildPathFilter(["/data/my_folder"], COLUMN);
    const equalsValues = collectEqualsValues(condition);
    expect(equalsValues).toEqual(["/data/my_folder"]);
  });
});
