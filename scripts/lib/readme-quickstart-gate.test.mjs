import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  extractQuickstartBlock,
  validateQuickstartSetsVersion,
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

// ── the real README ─────────────────────────────────────────────────────

test("the repo's actual README Quick Start block sets PINCHY_VERSION before starting", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const block = extractQuickstartBlock(readme);
  assert.deepEqual(validateQuickstartSetsVersion(block), []);
});
