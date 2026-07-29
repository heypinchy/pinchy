import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { toVitestPaths } from "./test-related.mjs";

/**
 * `vitest related` resolves its arguments against the vitest root, which is
 * packages/web — but the paths a user or `git diff` produces are relative to the
 * REPO root. Handing the latter straight through silently matches nothing and
 * reports "no test files found", which reads like "nothing to run" rather than
 * "you passed the wrong shape". That mistranslation is the whole job here.
 */
describe("translating repo-relative paths for vitest related", () => {
  test("rebases a web source file onto the vitest root", () => {
    assert.deepEqual(toVitestPaths(["packages/web/src/lib/audit.ts"]), [
      "src/lib/audit.ts",
    ]);
  });

  // The web vitest config includes ../plugins/pinchy-*, so a plugin edit has
  // real tests in this runner and must survive the translation.
  test("keeps plugin files reachable from the vitest root", () => {
    assert.deepEqual(
      toVitestPaths(["packages/plugins/pinchy-files/pdf-extract.ts"]),
      ["../plugins/pinchy-files/pdf-extract.ts"],
    );
  });

  test("passes a path that is already web-relative through unchanged", () => {
    // Someone running this from inside packages/web out of habit.
    assert.deepEqual(toVitestPaths(["src/lib/audit.ts"]), ["src/lib/audit.ts"]);
  });

  // Everything else genuinely has no tests in this runner. Dropping it is right;
  // passing it through would make vitest report a miss and hide the real hits.
  for (const path of [
    "docs/guides/agents.md",
    "scripts/lib/ci-path-filter.mjs",
    "AGENTS.md",
    "docker-compose.yml",
    ".github/workflows/ci.yml",
  ]) {
    test(`drops ${path} — nothing in the web runner covers it`, () => {
      assert.deepEqual(toVitestPaths([path]), []);
    });
  }

  test("keeps the order and drops duplicates", () => {
    assert.deepEqual(
      toVitestPaths([
        "packages/web/src/b.ts",
        "docs/x.md",
        "packages/web/src/a.ts",
        "packages/web/src/b.ts",
      ]),
      ["src/b.ts", "src/a.ts"],
    );
  });

  test("ignores blank lines from a git diff", () => {
    assert.deepEqual(toVitestPaths(["", "  ", "packages/web/src/a.ts"]), [
      "src/a.ts",
    ]);
  });

  test("returns nothing for an empty change set", () => {
    assert.deepEqual(toVitestPaths([]), []);
  });

  // `vitest related` walks the module graph, so only files that can BE a module
  // are useful arguments. A changed package.json or migration lives under
  // packages/web and really exists, so nothing above rejects it — and vitest
  // then reports "no test files found" and exits non-zero, turning a run that
  // had real targets into a spurious red.
  for (const path of [
    "packages/web/package.json",
    "packages/web/drizzle/0054_pgvector.sql",
    "packages/web/public/logo.svg",
    "packages/web/README.md",
    "packages/web/.env.example",
  ]) {
    test(`drops ${path} — not a module vitest can trace`, () => {
      assert.deepEqual(toVitestPaths([path]), []);
    });
  }

  test("keeps every script extension the runner can trace", () => {
    const sources = [
      "packages/web/src/a.ts",
      "packages/web/src/b.tsx",
      "packages/web/src/c.js",
      "packages/web/src/d.jsx",
      "packages/web/src/e.mts",
    ];
    assert.equal(toVitestPaths(sources).length, sources.length);
  });

  // A deleted file cannot be imported by anything, and handing it to vitest
  // makes the run error instead of testing the files that DO still exist.
  test("skips paths the caller marked as deleted", () => {
    assert.deepEqual(
      toVitestPaths(["packages/web/src/gone.ts"], {
        exists: (p) => !p.endsWith("gone.ts"),
      }),
      [],
    );
  });
});
