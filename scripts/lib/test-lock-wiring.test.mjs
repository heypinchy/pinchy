import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), "utf8"));
const rootScripts = read("package.json").scripts;
const webScripts = read("packages/web/package.json").scripts;

/**
 * The lock and the related-runner only help if the commands people actually
 * type go through them. Both are one careless edit away from being bypassed
 * while every check stays green — the same failure shape as the format gate
 * that only ever looked at packages/web: the mechanism still exists, it just
 * stops being reached.
 */
describe("the full suite cannot be run unserialized by accident", () => {
  // Wrapped in packages/web, NOT at the root: the root `test` only delegates,
  // so wrapping there would leave `pnpm -C packages/web test` unserialized —
  // and that is exactly what someone debugging one package types.
  for (const script of ["test", "test:unit"]) {
    test(`packages/web "${script}" goes through the lock`, () => {
      assert.match(
        webScripts[script] ?? "",
        /with-test-lock\.mjs/,
        `packages/web "${script}" must run through scripts/with-test-lock.mjs, ` +
          `or a second full suite can pile onto a running one.`,
      );
    });
  }

  test("the root test script still reaches the wrapped web script", () => {
    // It may delegate however it likes, but it must not call vitest directly.
    assert.doesNotMatch(rootScripts.test ?? "", /vitest/);
    assert.match(rootScripts.test ?? "", /@pinchy\/web/);
  });

  test("test:related exists at the root and takes no lock", () => {
    // The whole point is that it is cheaper to type than `pnpm test`. Behind
    // the lock it would be neither cheap nor tempting.
    assert.match(rootScripts["test:related"] ?? "", /test-related\.mjs/);
    assert.doesNotMatch(rootScripts["test:related"] ?? "", /with-test-lock/);
  });

  // It lives at the root ONLY. `packages/web` carried a second `test:related`
  // (`vitest related --run`) for weeks, because the two landed from different
  // branches — and they are not equivalent: the web one takes no change set of
  // its own and only understands vitest-root-relative paths, so it answers
  // "no test files found" to a repo-relative path, which reads like a pass.
  // Which of the two a reader reached for decided whether the tool worked.
  test("packages/web declares no second test:related", () => {
    assert.equal(
      webScripts["test:related"],
      undefined,
      `test:related belongs at the root (scripts/test-related.mjs), once. A ` +
        `web-local copy cannot derive your change set and silently matches ` +
        `nothing when handed a repo-relative path.`,
    );
  });

  // The runner's own suites must stay reachable by `pnpm test:scripts`, which
  // globs scripts/lib/*.test.mjs — a file moved out of that directory would
  // still pass locally and never run in CI again.
  test("the lock's own tests run in the scripts gate", () => {
    assert.match(
      rootScripts["test:scripts"] ?? "",
      /scripts\/lib\/\*\.test\.mjs/,
    );
  });
});
