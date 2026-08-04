import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  extractEnvExampleVars,
  findUndocumentedEnvVars,
} from "./env-var-doc-coverage.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REFERENCE_PAGE = join(
  REPO_ROOT,
  "docs/src/content/docs/reference/environment-variables.mdx",
);

// ── pure logic ────────────────────────────────────────────────────────────

test("extractEnvExampleVars reads a live assignment", () => {
  assert.deepEqual(extractEnvExampleVars("PINCHY_VERSION=v0.8.0\n"), [
    "PINCHY_VERSION",
  ]);
});

test("extractEnvExampleVars reads a commented-out optional line", () => {
  assert.deepEqual(extractEnvExampleVars("# DB_PASSWORD=\n"), ["DB_PASSWORD"]);
});

test("extractEnvExampleVars ignores a comment that isn't a variable", () => {
  assert.deepEqual(
    extractEnvExampleVars(
      "# Generate with: openssl rand -hex 32\n# ─────────────\n",
    ),
    [],
  );
});

test("extractEnvExampleVars deduplicates and sorts", () => {
  assert.deepEqual(
    extractEnvExampleVars(
      "# PINCHY_PORT=0.0.0.0:7777\nPINCHY_PORT=127.0.0.1\nDB_PASSWORD=x\n",
    ),
    ["DB_PASSWORD", "PINCHY_PORT"],
  );
});

test("findUndocumentedEnvVars does not accept a longer variable as the shorter one", () => {
  // PINCHY_PORT must not be satisfied by a page that only mentions
  // PINCHY_PORT_OLD or a substring match on a longer identifier.
  const problems = findUndocumentedEnvVars(
    ["PINCHY_PORT"],
    "`PINCHY_PORT_OLD` is deprecated.",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /PINCHY_PORT/);
});

test("findUndocumentedEnvVars is quiet when the page names the variable", () => {
  assert.deepEqual(
    findUndocumentedEnvVars(
      ["DB_PASSWORD"],
      "Set `DB_PASSWORD` for production.",
    ),
    [],
  );
});

test("findUndocumentedEnvVars points at the reference page", () => {
  const problems = findUndocumentedEnvVars(
    ["ENCRYPTION_KEY"],
    "no mention here",
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /environment-variables\.mdx/);
});

// ── the repo itself ───────────────────────────────────────────────────────

test("every .env.example variable is documented on the environment variables reference page", () => {
  const vars = extractEnvExampleVars(
    readFileSync(join(REPO_ROOT, ".env.example"), "utf8"),
  );
  // Guard the guard: a broken walker that finds nothing would pass silently.
  assert.ok(
    vars.length > 5,
    `expected the full variable set, found ${vars.length}`,
  );
  const mdx = readFileSync(REFERENCE_PAGE, "utf8");
  assert.deepEqual(findUndocumentedEnvVars(vars, mdx), []);
});
