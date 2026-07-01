// Regression guard for a real bug: vitest.config.ts's `exclude` list used to
// read `**/node_modules/**`, which LOOKS like it should filter out nested
// vendored test files under packages/plugins/pinchy-*/node_modules/**, but
// picomatch (vitest's real glob matcher) does not let a leading `**` span a
// `../` path segment. Since the `include` glob targets
// `../plugins/pinchy-*/**/...` (a relative, parent-traversing path), the old
// exclude silently failed to filter e.g.
// packages/plugins/pinchy-files/node_modules/lop/test/*.test.js, and `pnpm
// test` failed with "No test suite found in file ..." for every vendored
// test file.
//
// A hand-rolled regex-based glob matcher (like globToRegex in
// plugin-test-coverage.test.ts) would NOT have caught this, because it
// doesn't model picomatch's real `..`-segment behavior. So this test asks
// the real vitest CLI what it would actually collect, which is the only way
// to be sure the exclude glob works as intended.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "../../..");

describe("vitest.config.ts exclude", () => {
  it("does not collect vendored test files from nested plugin node_modules", () => {
    const output = execFileSync("npx", ["vitest", "list", "--filesOnly"], {
      cwd: WEB_ROOT,
      encoding: "utf-8",
      timeout: 60_000,
    });

    const files = output.split("\n").filter((line) => line.trim().length > 0);
    const vendored = files.filter((f) => f.includes("node_modules"));

    expect(
      vendored,
      [
        "vitest would collect these vendored node_modules test files as if",
        "they were first-party tests (they'll fail with 'No test suite",
        "found'). Fix the `exclude` glob in vitest.config.ts.",
      ].join("\n")
    ).toEqual([]);
  });
});
