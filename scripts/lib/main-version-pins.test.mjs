import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSemver,
  isFullMinorBehind,
  readReadmeVersionPin,
  readPackageJsonVersion,
  collectMainVersionPins,
  findStaleVersionPins,
  DECLARED_VERSION_PINS,
} from "./main-version-pins.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHECK_SCRIPT = resolve(ROOT, "scripts/check-main-version-pins.mjs");
const WORKFLOW = resolve(ROOT, ".github/workflows/docs-freshness.yml");

// ─── parseSemver ────────────────────────────────────────────────────────────

test("parseSemver reads a v-prefixed version", () => {
  assert.deepEqual(parseSemver("v0.9.1"), { major: 0, minor: 9, patch: 1 });
});

test("parseSemver reads a bare version (no leading v)", () => {
  assert.deepEqual(parseSemver("0.8.0"), { major: 0, minor: 8, patch: 0 });
});

test("parseSemver throws on garbage", () => {
  assert.throws(() => parseSemver("not-a-version"), /vX\.Y\.Z/);
});

// ─── isFullMinorBehind ──────────────────────────────────────────────────────

test("same version is not behind", () => {
  assert.equal(isFullMinorBehind("v0.9.1", "v0.9.1"), false);
});

test("a patch-only lag is not flagged", () => {
  // main pinned at v0.9.0, latest release is a patch v0.9.1 — normal gap
  // between forward-ports, not the drift this guard hunts.
  assert.equal(isFullMinorBehind("v0.9.0", "v0.9.1"), false);
});

test("a full minor lag IS flagged", () => {
  // This is the exact shape of #1079: main pinned at v0.8.0 while v0.9.1 has
  // shipped.
  assert.equal(isFullMinorBehind("v0.8.0", "v0.9.1"), true);
});

test("a major-version lag is flagged even with a lower minor", () => {
  assert.equal(isFullMinorBehind("v0.9.5", "v1.0.0"), true);
});

test("pinned ahead of latest is not flagged", () => {
  assert.equal(isFullMinorBehind("v0.9.1", "v0.9.0"), false);
});

// ─── readReadmeVersionPin ───────────────────────────────────────────────────

const README_FIXTURE = `# Pinchy

## Quick Start

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/heypinchy/pinchy/v0.9.1/docker-compose.yml -o docker-compose.yml
echo "PINCHY_VERSION=v0.9.1" > .env
docker compose up -d
\`\`\`

## Next section
`;

test("readReadmeVersionPin reads the quick-start PINCHY_VERSION pin", () => {
  assert.equal(readReadmeVersionPin(README_FIXTURE), "v0.9.1");
});

test("readReadmeVersionPin throws when the quick-start section is missing", () => {
  assert.throws(() => readReadmeVersionPin("# Pinchy\n\nno quickstart here\n"));
});

// ─── readPackageJsonVersion ─────────────────────────────────────────────────

test("readPackageJsonVersion reads the bare version field", () => {
  assert.equal(
    readPackageJsonVersion(
      JSON.stringify({ name: "pinchy", version: "0.8.0" }),
    ),
    "0.8.0",
  );
});

test("readPackageJsonVersion throws when there is no version field", () => {
  assert.throws(
    () => readPackageJsonVersion(JSON.stringify({ name: "pinchy" })),
    /version/,
  );
});

// ─── collectMainVersionPins / findStaleVersionPins ─────────────────────────

const ENV_EXAMPLE_FIXTURE = "PINCHY_VERSION=v0.8.0\n";

const DO_TEMPLATE_FIXTURE = JSON.stringify({
  variables: { application_name: "Pinchy", application_version: "v0.8.0" },
});

const CAPROVER_TEMPLATE_FIXTURE = `caproverOneClickApp:
  variables:
    - id: $$cap_pinchy_version
      defaultValue: 'v0.8.0'
`;

/** Every file `pnpm release` bumps, all pinned at v0.8.0 except the README. */
const STALE_FIXTURES = {
  readme: README_FIXTURE,
  envExample: ENV_EXAMPLE_FIXTURE,
  rootPackageJson: JSON.stringify({ name: "pinchy", version: "0.8.0" }),
  webPackageJson: JSON.stringify({ name: "@pinchy/web", version: "0.8.0" }),
  digitalOcean: DO_TEMPLATE_FIXTURE,
  caprover: CAPROVER_TEMPLATE_FIXTURE,
};

test("collectMainVersionPins reads every file pnpm release bumps", () => {
  assert.deepEqual(collectMainVersionPins(STALE_FIXTURES), {
    "README quick-start": "v0.9.1",
    ".env.example": "v0.8.0",
    "package.json": "0.8.0",
    "packages/web/package.json": "0.8.0",
    "DigitalOcean marketplace template": "v0.8.0",
    "CapRover marketplace template": "v0.8.0",
  });
});

test("findStaleVersionPins flags only the pins a full minor behind the latest release", () => {
  const stale = findStaleVersionPins(
    collectMainVersionPins(STALE_FIXTURES),
    "v0.9.1",
  );
  const labels = stale.map((s) => s.label).sort();
  assert.deepEqual(labels, [
    ".env.example",
    "CapRover marketplace template",
    "DigitalOcean marketplace template",
    "package.json",
    "packages/web/package.json",
  ]);
  for (const entry of stale) {
    assert.match(entry.pinned, /^v?0\.8\.0$/);
    assert.equal(entry.latest, "v0.9.1");
  }
});

test("findStaleVersionPins flags nothing when every pin matches the latest release", () => {
  const pins = collectMainVersionPins({
    readme: README_FIXTURE,
    envExample: "PINCHY_VERSION=v0.9.1\n",
    rootPackageJson: JSON.stringify({ version: "0.9.1" }),
    webPackageJson: JSON.stringify({ version: "0.9.1" }),
    digitalOcean: JSON.stringify({
      variables: { application_version: "v0.9.1" },
    }),
    caprover: CAPROVER_TEMPLATE_FIXTURE.replace("v0.8.0", "v0.9.1"),
  });
  assert.deepEqual(findStaleVersionPins(pins, "v0.9.1"), []);
});

// ─── The extractors still match the real files ──────────────────────────────
// Fixtures prove the logic; they say nothing about whether the six regexes and
// JSON paths still find anything in the repo as it stands today. Every sibling
// guard reads the real files for exactly this reason (marketplace-version.mjs
// against the real .env.example + templates, readme-quickstart-gate.mjs
// against the real README). Without it, a reformatted pinchy.yml or a renamed
// README heading surfaces as a stack trace in a weekly cron nobody watches,
// instead of as a red PR.
//
// This asserts only that every pin is READABLE — not that it is current. main
// is legitimately behind the latest release between a tag and its forward-port,
// and asserting otherwise would make this test fail on the calendar.

test("every tracked pin is readable from the repo's actual files", () => {
  const pins = collectMainVersionPins({
    readme: readFileSync(resolve(ROOT, "README.md"), "utf8"),
    envExample: readFileSync(resolve(ROOT, ".env.example"), "utf8"),
    rootPackageJson: readFileSync(resolve(ROOT, "package.json"), "utf8"),
    webPackageJson: readFileSync(
      resolve(ROOT, "packages/web/package.json"),
      "utf8",
    ),
    digitalOcean: readFileSync(
      resolve(ROOT, "marketplace/digitalocean/template.json"),
      "utf8",
    ),
    caprover: readFileSync(
      resolve(ROOT, "marketplace/caprover/pinchy.yml"),
      "utf8",
    ),
  });
  for (const [label, pinned] of Object.entries(pins)) {
    // The two declared pins carry `<next>-dev` between releases (#1044), which
    // parseSemver rejects on purpose — findStaleVersionPins short-circuits them
    // before it gets there. Readability for those means "parses once the
    // suffix is off".
    const value =
      DECLARED_VERSION_PINS.has(label) && /-dev$/.test(pinned)
        ? pinned.slice(0, -4)
        : pinned;
    assert.doesNotThrow(
      () => parseSemver(value),
      `${label} did not yield a vX.Y.Z version (got "${pinned}")`,
    );
  }
});

// The two halves of #1044's split, as this guard sees them.

test("a `-dev` declared pin is the intended state, not drift", () => {
  assert.deepEqual(
    findStaleVersionPins(
      {
        "package.json": "0.10.0-dev",
        "packages/web/package.json": "0.10.0-dev",
        ".env.example": "v0.9.1",
      },
      "v0.9.1",
    ),
    [],
  );
});

test("a declared pin WITHOUT the suffix is still checked — the v0.9.0-cycle incident", () => {
  const stale = findStaleVersionPins(
    { "package.json": "0.8.0", "packages/web/package.json": "0.8.0" },
    "v0.9.1",
  );
  assert.deepEqual(
    stale.map((s) => s.label),
    ["package.json", "packages/web/package.json"],
    "a bare version claims to BE a release, so it has to be a current one",
  );
});

test("`-dev` does not excuse an INSTALL pin — those must name a tag that exists", () => {
  // The short-circuit is keyed on the label, not on the suffix, so a `-dev` in
  // an install pin still reaches parseSemver and throws. Loud is right here:
  // that value is a `docker pull` nobody can run. The PR gate that catches it
  // first is version-identity.mjs, which requires .env.example to equal the
  // newest release exactly; this is the backstop behind it.
  assert.throws(
    () => findStaleVersionPins({ ".env.example": "v0.8.0-dev" }, "v0.9.1"),
    /vX\.Y\.Z/,
  );
});

test("collectMainVersionPins covers every file scripts/release.mjs bumps", () => {
  // The forward-port step this guard backs names all six files. A release
  // bumper that grows a seventh must not leave the tripwire reporting on six.
  const release = readFileSync(resolve(ROOT, "scripts/release.mjs"), "utf8");
  for (const path of [
    "package.json",
    "packages/web/package.json",
    ".env.example",
    "README.md",
    "marketplace/digitalocean/template.json",
    "marketplace/caprover/pinchy.yml",
  ]) {
    assert.ok(
      release.includes(path),
      `release.mjs no longer bumps ${path} — re-check what this guard tracks`,
    );
  }
  const labels = Object.keys(collectMainVersionPins(STALE_FIXTURES));
  assert.equal(
    labels.length,
    6,
    `expected a pin per bumped file, got ${labels.join(", ")}`,
  );
});

// ─── CI wiring guard ────────────────────────────────────────────────────────
// A guard that isn't run finds nothing, exactly like the marketplace-version
// guard's own "release-script wiring" section this mirrors. These textual
// checks fail if the workflow stops calling the script, or is edited to
// rescue a real failure into a green run — see AGENTS.md § "An Outside
// Reporter Never Waits Silently" for why a rescued cron is the worse bug.

function uncommented(yaml) {
  return yaml
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

/**
 * Returns the YAML block belonging to one job, ending at the NEXT job key
 * rather than at a hard-coded sibling name or at EOF.
 *
 * Both matter, and both were wrong before. Slicing to EOF makes every
 * assertion below read whatever job is appended next: a `continue-on-error`
 * in an unrelated later job gets blamed on this one (false red). Naming a
 * specific sibling is worse — `freshness` sits ABOVE version-pins, so the
 * lookup never matched and the slice silently ran to EOF anyway.
 */
function jobBlock(yaml, jobName) {
  const start = yaml.indexOf(`\n  ${jobName}:`);
  assert.notEqual(start, -1, `docs-freshness.yml has no ${jobName} job`);
  const rest = yaml.slice(start + 1);
  const next = /\n {2}[A-Za-z_][\w-]*:/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

test("check-main-version-pins.mjs exists", () => {
  assert.doesNotThrow(() => readFileSync(CHECK_SCRIPT, "utf8"));
});

test("the version-pins job itself runs check-main-version-pins.mjs", () => {
  // Scoped to the job on purpose. Matching the whole file passes just as
  // happily when the run step has been gutted and the script is invoked from
  // some other job — verified by canary: replacing this job's `run:` with
  // `echo idle` and chaining the script onto the freshness job left the old,
  // unscoped assertions 17/17 green.
  const block = jobBlock(
    uncommented(readFileSync(WORKFLOW, "utf8")),
    "version-pins",
  );
  assert.match(block, /run:\s*node scripts\/check-main-version-pins\.mjs/);
});

test("docs-freshness.yml runs on a schedule", () => {
  assert.match(
    uncommented(readFileSync(WORKFLOW, "utf8")),
    /^on:\n(.*\n)*?\s+schedule:/m,
  );
});

test("the version-pins job is never rescued into a green run", () => {
  const block = jobBlock(
    uncommented(readFileSync(WORKFLOW, "utf8")),
    "version-pins",
  );
  assert.doesNotMatch(block, /continue-on-error/);
  assert.doesNotMatch(block, /\|\|\s*true/);
  assert.doesNotMatch(block, /exit 0/);
});

test("the version-pins job grants only the contents:read it needs", () => {
  const block = jobBlock(
    uncommented(readFileSync(WORKFLOW, "utf8")),
    "version-pins",
  );
  assert.match(block, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(block, /issues:\s*write/);
});

test("jobBlock stops at the next job instead of running to EOF", () => {
  // The property the two assertions above depend on. Without it an unrelated
  // job appended later turns this guard red — also verified by canary.
  const yaml = [
    "jobs:",
    "  version-pins:",
    "    runs-on: ubuntu-latest",
    "  later-job:",
    "    continue-on-error: true",
  ].join("\n");
  const block = jobBlock(yaml, "version-pins");
  assert.match(block, /runs-on/);
  assert.doesNotMatch(block, /continue-on-error/);
});
