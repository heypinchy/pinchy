import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREV_VERSION_CONSUMERS,
  stripJsComments,
  findReachableTagDerivations,
  readsFrozenSectionReader,
  checkPrevVersionSource,
} from "./release-prev-version.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// ─── stripJsComments ─────────────────────────────────────────────────────────
//
// Comments must go, string literals must NOT. The thing being detected IS a
// string literal — `exec("git describe --tags --abbrev=0")` — so a stripper
// that also blanks strings would report nothing and read as a clean pass.

test("stripJsComments removes line and block comments", () => {
  const src = [
    "// git describe --tags is what we used to do",
    "/* git describe --tags in a block */",
    'const a = exec("keep me");',
  ].join("\n");
  const out = stripJsComments(src);
  assert.equal(out.includes("used to do"), false);
  assert.equal(out.includes("in a block"), false);
  assert.equal(out.includes("keep me"), true);
});

test("stripJsComments keeps a // inside a string literal", () => {
  const src = 'const u = "https://example.com/x"; // trailing';
  const out = stripJsComments(src);
  assert.equal(out.includes("https://example.com/x"), true);
  assert.equal(out.includes("trailing"), false);
});

// ─── findReachableTagDerivations ─────────────────────────────────────────────

test("flags a prev-version derived from the newest reachable tag", () => {
  const src =
    'prevVersion = exec("git describe --tags --abbrev=0").replace(/^v/, "");';
  assert.equal(findReachableTagDerivations(src).length, 1);
});

test("does not flag the same call named only in a comment", () => {
  const src =
    '// was: exec("git describe --tags --abbrev=0")\nconst v = newestFrozenRelease(mdx);';
  assert.deepEqual(findReachableTagDerivations(src), []);
});

test("does not flag an unrelated git call", () => {
  assert.deepEqual(findReachableTagDerivations('exec("git tag --list")'), []);
  assert.deepEqual(
    findReachableTagDerivations('exec("git rev-parse HEAD")'),
    [],
  );
});

// ─── readsFrozenSectionReader ────────────────────────────────────────────────

test("recognises the frozen-section reader, and not a mention of it", () => {
  assert.equal(
    readsFrozenSectionReader("import { newestFrozenRelease } from './x.mjs';"),
    true,
  );
  assert.equal(readsFrozenSectionReader("// see newestFrozenRelease"), false);
});

// ─── the real files ──────────────────────────────────────────────────────────
//
// The bug this guard exists for: v0.9.0 and v0.9.1 were cut from release/0.9,
// which never merged back, so `git describe` from main answers v0.8.0 and the
// upgrade-notes gate aborts on a section that is not the one anybody wrote.

test("every release-path consumer derives the previous version from upgrading.mdx", () => {
  // A corpus that shrinks to nothing is a guard that stopped guarding: an
  // unreadable file must throw, not read as "no offenders".
  assert.ok(
    PREV_VERSION_CONSUMERS.length >= 2,
    "expected at least two consumers",
  );

  const problems = [];
  for (const rel of PREV_VERSION_CONSUMERS) {
    const source = readFileSync(resolve(ROOT, rel), "utf8");
    problems.push(...checkPrevVersionSource(source, rel));
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});
