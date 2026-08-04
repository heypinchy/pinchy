import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  extractQuickstartBlock,
  validateQuickstartSetsVersion,
  validateQuickstartVersionsAgree,
} from "./readme-quickstart-gate.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const GOOD_README = [
  "# Pinchy",
  "",
  "## Quick Start",
  "",
  "```bash",
  "curl -fsSL https://raw.githubusercontent.com/heypinchy/pinchy/v0.9.1/docker-compose.yml -o docker-compose.yml",
  'echo "PINCHY_VERSION=v0.9.1" > .env',
  "docker compose up -d",
  "# Open http://localhost:7777 — the setup wizard creates your admin account",
  "```",
  "",
  "## Status",
].join("\n");

const BAD_README = [
  "# Pinchy",
  "",
  "## Quick Start",
  "",
  "```bash",
  "curl -fsSL https://raw.githubusercontent.com/heypinchy/pinchy/v0.8.0/docker-compose.yml -o docker-compose.yml",
  "docker compose up -d",
  "# Open http://localhost:7777 — the setup wizard creates your admin account",
  "```",
  "",
  "## Status",
].join("\n");

// ── extractQuickstartBlock ──────────────────────────────────────────────

test("extractQuickstartBlock returns the bash block after the heading", () => {
  const block = extractQuickstartBlock(GOOD_README);
  assert.match(block, /docker compose up -d/);
  assert.match(block, /PINCHY_VERSION/);
});

test("extractQuickstartBlock throws when the heading is missing", () => {
  assert.throws(
    () => extractQuickstartBlock("# Pinchy\n\nNo quickstart here.\n"),
    /Quick Start/,
  );
});

test("extractQuickstartBlock throws when no bash block follows the heading", () => {
  assert.throws(
    () => extractQuickstartBlock("# Pinchy\n\n## Quick Start\n\nProse only.\n"),
    /bash code block/,
  );
});

// The search is bounded to the Quick Start section. Unbounded, a README whose
// quickstart block was removed would silently hand the next section's bash
// block to the validators — a guard reporting on the wrong thing, which reads
// exactly like a guard reporting nothing is wrong.
test("extractQuickstartBlock does not reach into a later section's bash block", () => {
  const readme = [
    "# Pinchy",
    "",
    "## Quick Start",
    "",
    "Prose only — the block was removed.",
    "",
    "## Development",
    "",
    "```bash",
    "docker compose up -d",
    "```",
  ].join("\n");
  assert.throws(() => extractQuickstartBlock(readme), /bash code block/);
});

// ── validateQuickstartSetsVersion ───────────────────────────────────────

test("validateQuickstartSetsVersion accepts a block that sets PINCHY_VERSION before starting", () => {
  const block = extractQuickstartBlock(GOOD_README);
  assert.deepEqual(validateQuickstartSetsVersion(block), []);
});

test("validateQuickstartSetsVersion flags a block that never sets PINCHY_VERSION", () => {
  // The exact shape that broke the README quickstart: curl + `docker compose
  // up -d` with nothing writing PINCHY_VERSION in between, while
  // docker-compose.yml requires it and refuses to start otherwise.
  const block = extractQuickstartBlock(BAD_README);
  const problems = validateQuickstartSetsVersion(block);
  assert.ok(
    problems.some((p) => /PINCHY_VERSION/.test(p)),
    `expected a PINCHY_VERSION problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateQuickstartSetsVersion flags PINCHY_VERSION set only AFTER docker compose up", () => {
  // Order matters: setting the variable after the command that needs it
  // does not help the reader who copy-pasted the block top to bottom.
  const block = [
    "curl -fsSL https://example.invalid/docker-compose.yml -o docker-compose.yml",
    "docker compose up -d",
    'echo "PINCHY_VERSION=v0.9.1" > .env',
  ].join("\n");
  const problems = validateQuickstartSetsVersion(block);
  assert.ok(
    problems.some((p) => /PINCHY_VERSION/.test(p)),
    `expected a PINCHY_VERSION problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateQuickstartSetsVersion flags a block with no docker compose up command", () => {
  const problems = validateQuickstartSetsVersion(
    'echo "PINCHY_VERSION=v0.9.1" > .env\n',
  );
  assert.ok(
    problems.some((p) => /docker compose up/.test(p)),
    `expected a missing-command problem, got ${JSON.stringify(problems)}`,
  );
});

// A line that merely NAMES the variable is prose, not a setting. Matching it
// would make the guard green on a block that still fails on command one.
test("validateQuickstartSetsVersion does not accept a comment mentioning PINCHY_VERSION", () => {
  const problems = validateQuickstartSetsVersion(
    [
      "# PINCHY_VERSION is picked up automatically",
      "docker compose up -d",
    ].join("\n"),
  );
  assert.ok(
    problems.some((p) => /without setting PINCHY_VERSION/.test(p)),
    `expected a PINCHY_VERSION problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateQuickstartSetsVersion accepts an inline variable assignment", () => {
  assert.deepEqual(
    validateQuickstartSetsVersion(
      ["export PINCHY_VERSION=v0.9.1", "docker compose up -d"].join("\n"),
    ),
    [],
  );
});

// ── validateQuickstartVersionsAgree ─────────────────────────────────────

test("validateQuickstartVersionsAgree accepts a block whose two pins match", () => {
  assert.deepEqual(
    validateQuickstartVersionsAgree(extractQuickstartBlock(GOOD_README)),
    [],
  );
});

// The regression: `pnpm release` bumping only the curl URL leaves the reader
// installing the new release's compose file against the previous release's
// images. Nothing fails, so only a guard can catch it.
test("validateQuickstartVersionsAgree flags a compose URL and .env pin that disagree", () => {
  const problems = validateQuickstartVersionsAgree(
    [
      "curl -fsSL https://raw.githubusercontent.com/heypinchy/pinchy/v0.10.0/docker-compose.yml -o docker-compose.yml",
      'echo "PINCHY_VERSION=v0.9.1" > .env',
      "docker compose up -d",
    ].join("\n"),
  );
  assert.ok(
    problems.some((p) => /pins disagree/.test(p)),
    `expected a disagreeing-pins problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateQuickstartVersionsAgree flags a block with no pinned compose URL", () => {
  const problems = validateQuickstartVersionsAgree(
    ['echo "PINCHY_VERSION=v0.9.1" > .env', "docker compose up -d"].join("\n"),
  );
  assert.ok(
    problems.some((p) => /no pinned docker-compose URL/.test(p)),
    `expected a missing-URL problem, got ${JSON.stringify(problems)}`,
  );
});

test("validateQuickstartVersionsAgree flags a block with no PINCHY_VERSION pin", () => {
  const problems = validateQuickstartVersionsAgree(
    extractQuickstartBlock(BAD_README),
  );
  assert.ok(
    problems.some((p) => /pins no PINCHY_VERSION/.test(p)),
    `expected a missing-pin problem, got ${JSON.stringify(problems)}`,
  );
});

// ── the real README ─────────────────────────────────────────────────────

test("the repo's actual README Quick Start block sets PINCHY_VERSION before starting", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const block = extractQuickstartBlock(readme);
  assert.deepEqual(validateQuickstartSetsVersion(block), []);
});

test("the repo's actual README Quick Start block pins one version, not two", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const block = extractQuickstartBlock(readme);
  assert.deepEqual(validateQuickstartVersionsAgree(block), []);
});

// The guard and the release script have to agree about what the quickstart
// looks like: the gate asserts the two pins match, `pnpm release` is what keeps
// them matching. If the bumper stops covering a pin, the next release ships a
// README this gate then fails on — so pin the pairing here, where it is cheap.
test("pnpm release bumps both pins the gate checks", async () => {
  const { bumpReadmeQuickstartPins } = await import("./release-logic.mjs");
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const block = extractQuickstartBlock(
    bumpReadmeQuickstartPins(readme, "9.9.9"),
  );
  assert.deepEqual(validateQuickstartVersionsAgree(block), []);
  assert.match(block, /PINCHY_VERSION=v9\.9\.9/);
  assert.match(block, /pinchy\/v9\.9\.9\/docker-compose\.yml/);
});
