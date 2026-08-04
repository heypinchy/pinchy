import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  newestFrozenRelease,
  readEnvExampleVersion,
  readReadmeComposePins,
  checkVersionIdentity,
} from "./version-identity.mjs";
import { parseDeclaredVersion, compareVersions } from "./release-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// ─── fixtures ────────────────────────────────────────────────────────────────

const MDX = [
  "## Upgrading from v0.9.1 to %%PINCHY_VERSION%%",
  "",
  "Open.",
  "",
  "## Upgrading from v0.9.0 to v0.9.1",
  "",
  "Shipped.",
  "",
  "## Upgrading from v0.8.0 to v0.9.0",
  "",
  "Shipped.",
  "",
].join("\n");

const ENV = (v) => `# comment\nPINCHY_VERSION=${v}\nOTHER=1\n`;

const README = (v) =>
  [
    "## Quick Start",
    "",
    "```bash",
    `curl -fsSL https://raw.githubusercontent.com/heypinchy/pinchy/${v}/docker-compose.yml -o docker-compose.yml`,
    "docker compose up -d",
    "```",
    "",
  ].join("\n");

const ok = (over = {}) =>
  checkVersionIdentity({
    rootVersion: "0.10.0-dev",
    webVersion: "0.10.0-dev",
    envExample: ENV("v0.9.1"),
    readme: README("v0.9.1"),
    mdx: MDX,
    ...over,
  });

// ─── parseDeclaredVersion ────────────────────────────────────────────────────

test("parseDeclaredVersion splits a released version and a dev version", () => {
  assert.deepEqual(parseDeclaredVersion("0.9.1"), {
    released: "0.9.1",
    isDev: false,
  });
  assert.deepEqual(parseDeclaredVersion("0.10.0-dev"), {
    released: "0.10.0",
    isDev: true,
  });
  assert.deepEqual(parseDeclaredVersion("v0.9.1"), {
    released: "0.9.1",
    isDev: false,
  });
});

test("parseDeclaredVersion rejects other pre-release spellings", () => {
  // Accepting -rc.1 / -alpha would make "is this a development tree?" a semver
  // precedence question in every consumer. It is meant to be a string check.
  for (const bad of ["0.10.0-rc.1", "0.10.0-alpha", "0.10.0+dev", "0.10", ""]) {
    assert.throws(() => parseDeclaredVersion(bad), /Invalid declared version/);
  }
});

// ─── compareVersions, as this guard depends on it ────────────────────────────

test("compareVersions orders by number, not lexically", () => {
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
  assert.ok(compareVersions("0.10.0", "0.9.1") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

// Why compareVersions was hardened in the same change. It used to do
// `.split(".").map(Number)`, so "0.10.0-dev" became [0, 10, NaN]; every NaN
// comparison is false, so it fell through and returned 0 — "equal" for two
// versions it never managed to read. Introducing a suffixed version while that
// stood would have made this guard answer "consistent" for the exact state it
// exists to catch.
test("compareVersions refuses input it cannot order instead of returning 0", () => {
  assert.throws(
    () => compareVersions("0.10.0-dev", "0.9.1"),
    /Not an orderable release version/,
  );
});

// ─── newestFrozenRelease ─────────────────────────────────────────────────────

test("newestFrozenRelease reads the newest shipped section, not the open one", () => {
  assert.equal(newestFrozenRelease(MDX), "0.9.1");
});

test("newestFrozenRelease orders numerically across a ten-boundary", () => {
  const mdx = [
    "## Upgrading from v0.9.0 to v0.10.0",
    "",
    "Shipped.",
    "",
    "## Upgrading from v0.8.0 to v0.9.0",
    "",
    "Shipped.",
    "",
  ].join("\n");
  assert.equal(newestFrozenRelease(mdx), "0.10.0");
});

test("newestFrozenRelease returns null when nothing has shipped", () => {
  assert.equal(
    newestFrozenRelease("## Upgrading from v0.1.0 to %%PINCHY_VERSION%%\n"),
    null,
  );
});

// ─── readEnvExampleVersion ───────────────────────────────────────────────────

test("readEnvExampleVersion finds the line among others", () => {
  assert.equal(readEnvExampleVersion(ENV("v0.9.1")), "v0.9.1");
  assert.equal(readEnvExampleVersion("NOTHING=1\n"), null);
});

// ─── readReadmeComposePins ───────────────────────────────────────────────────

test("readReadmeComposePins reads the quick-start install pin", () => {
  assert.deepEqual(readReadmeComposePins(README("v0.9.1")), ["v0.9.1"]);
  assert.deepEqual(readReadmeComposePins("no install instructions here"), []);
});

// Every pin is returned, not just the first: `bumpReadmeComposePin` rewrites
// them all, so a guard that reads one would pass a README where a second copy
// of the command drifted.
test("readReadmeComposePins returns every distinct pin, in order", () => {
  const two = README("v0.9.1") + README("v0.8.0") + README("v0.9.1");
  assert.deepEqual(readReadmeComposePins(two), ["v0.9.1", "v0.8.0"]);
});

// ─── checkVersionIdentity ────────────────────────────────────────────────────

test("a development tree ahead of the newest release is consistent", () => {
  assert.deepEqual(ok(), []);
});

test("a release commit — version equals the newest release, no suffix — is consistent", () => {
  assert.deepEqual(
    ok({ rootVersion: "0.9.1", webVersion: "0.9.1" }),
    [],
    "right at a release the tree really IS that release",
  );
});

// The measured bug: main said 0.8.0 on 2026-08-04 while v0.9.1 was current,
// because 0.9.x was cut from release/0.9 and main never took the bump.
test("the release-branch drift is caught: declared version behind the newest release", () => {
  const problems = ok({ rootVersion: "0.8.0", webVersion: "0.8.0" });
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /declares 0\.8\.0 while the newest released version/,
  );
  assert.match(problems[0], /release branch does not bump/);
});

test("a bare version AHEAD of every release is flagged as an unmarked dev tree", () => {
  const problems = ok({ rootVersion: "0.10.0", webVersion: "0.10.0" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /say so with/);
});

test("a -dev version that is NOT ahead of the newest release is flagged", () => {
  // 0.9.1-dev after v0.9.1 shipped: the suffix says "unreleased" while the
  // number says "the release that already happened".
  const problems = ok({ rootVersion: "0.9.1-dev", webVersion: "0.9.1-dev" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must be AHEAD of the newest release/);
});

test("root and packages/web drifting apart is flagged on its own", () => {
  const problems = ok({ webVersion: "0.9.1" });
  assert.ok(problems.some((p) => /must not diverge/.test(p)));
});

// .env.example is the one place the number is an instruction rather than a
// label: it is the image tag a new install pulls.
test(".env.example pinning a superseded release is flagged", () => {
  const problems = ok({ envExample: ENV("v0.8.0") });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /image tag a new install pulls/);
});

test(".env.example must never carry the -dev version", () => {
  const problems = ok({ envExample: ENV("v0.10.0-dev") });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /a tag that exists/);
});

test("a missing PINCHY_VERSION line is flagged", () => {
  const problems = ok({ envExample: "OTHER=1\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /which image to pull/);
});

// The README quick-start curl is the most-read install instruction the repo
// has — it is what a visitor runs off the GitHub front page — and `pnpm release`
// bumps it (`bumpReadmeComposePin`) for exactly that reason. So it belongs to
// the same "what should I pull?" set as .env.example and the marketplace
// templates, and a release cut from a release branch leaves it behind on `main`
// identically. It really was still on v0.8.0 when this guard was written, two
// releases after the fact, and `bumpReadmeComposePin`'s own docstring records
// the same drift one cycle earlier (v0.5.7 through both v0.5.8 and v0.6.0).
test("a README install pin on a superseded release is flagged", () => {
  const problems = ok({ readme: README("v0.8.0") });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /README/);
  assert.match(problems[0], /v0\.8\.0/);
});

test("a README with no install pin at all is flagged", () => {
  // Not silence: the pin moving or being reworded is precisely how this stops
  // being checked, and `bumpReadmeComposePin` throws on the same condition.
  const problems = ok({ readme: "# Pinchy\n\nNo quick start.\n" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no pinned docker-compose URL/i);
});

test("every drifted README pin is named, not just the first", () => {
  const problems = ok({ readme: README("v0.8.0") + README("v0.7.0") });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /v0\.8\.0/);
  assert.match(problems[0], /v0\.7\.0/);
});

test("an unreadable declared version stops the run rather than guessing", () => {
  const problems = ok({ rootVersion: "not-a-version" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Root package\.json/);
});

// ─── the real repo ───────────────────────────────────────────────────────────

test("this repo's version declarations agree", () => {
  const read = (p) => readFileSync(resolve(ROOT, p), "utf8");
  const problems = checkVersionIdentity({
    rootVersion: JSON.parse(read("package.json")).version,
    webVersion: JSON.parse(read("packages/web/package.json")).version,
    envExample: read(".env.example"),
    readme: read("README.md"),
    mdx: read("docs/src/content/docs/guides/upgrading.mdx"),
  });
  assert.deepEqual(
    problems,
    [],
    `\n${problems.join("\n")}\n\nSee AGENTS.md § "Two Version Numbers, And Which Question Each Answers".`,
  );
});
