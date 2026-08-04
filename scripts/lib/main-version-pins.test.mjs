import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSemver,
  isFullMinorBehind,
  readReadmeVersionPin,
  collectMainVersionPins,
  findStaleVersionPins,
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

test("collectMainVersionPins reads all four pins", () => {
  const pins = collectMainVersionPins({
    readme: README_FIXTURE,
    envExample: ENV_EXAMPLE_FIXTURE,
    digitalOcean: DO_TEMPLATE_FIXTURE,
    caprover: CAPROVER_TEMPLATE_FIXTURE,
  });
  assert.deepEqual(pins, {
    "README quick-start": "v0.9.1",
    ".env.example": "v0.8.0",
    "DigitalOcean marketplace template": "v0.8.0",
    "CapRover marketplace template": "v0.8.0",
  });
});

test("findStaleVersionPins flags only the pins a full minor behind the latest release", () => {
  const pins = collectMainVersionPins({
    readme: README_FIXTURE,
    envExample: ENV_EXAMPLE_FIXTURE,
    digitalOcean: DO_TEMPLATE_FIXTURE,
    caprover: CAPROVER_TEMPLATE_FIXTURE,
  });
  const stale = findStaleVersionPins(pins, "v0.9.1");
  const labels = stale.map((s) => s.label).sort();
  assert.deepEqual(labels, [
    ".env.example",
    "CapRover marketplace template",
    "DigitalOcean marketplace template",
  ]);
  for (const entry of stale) {
    assert.equal(entry.pinned, "v0.8.0");
    assert.equal(entry.latest, "v0.9.1");
  }
});

test("findStaleVersionPins flags nothing when every pin matches the latest release", () => {
  const pins = collectMainVersionPins({
    readme: README_FIXTURE,
    envExample: "PINCHY_VERSION=v0.9.1\n",
    digitalOcean: JSON.stringify({
      variables: { application_version: "v0.9.1" },
    }),
    caprover: CAPROVER_TEMPLATE_FIXTURE.replace("v0.8.0", "v0.9.1"),
  });
  assert.deepEqual(findStaleVersionPins(pins, "v0.9.1"), []);
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

test("check-main-version-pins.mjs exists", () => {
  assert.doesNotThrow(() => readFileSync(CHECK_SCRIPT, "utf8"));
});

test("docs-freshness.yml runs check-main-version-pins.mjs on a schedule", () => {
  const yaml = uncommented(readFileSync(WORKFLOW, "utf8"));
  assert.match(yaml, /schedule:/);
  assert.match(yaml, /check-main-version-pins\.mjs/);
});

test("the version-pins job is never rescued into a green run", () => {
  const yaml = uncommented(readFileSync(WORKFLOW, "utf8"));
  const jobStart = yaml.indexOf("version-pins:");
  assert.notEqual(jobStart, -1, "docs-freshness.yml has no version-pins job");
  const jobBlock = yaml.slice(jobStart);
  assert.doesNotMatch(jobBlock, /continue-on-error/);
  assert.doesNotMatch(jobBlock, /\|\|\s*true/);
  assert.doesNotMatch(jobBlock, /exit 0/);
});

test("the version-pins job grants only the contents:read it needs", () => {
  const yaml = uncommented(readFileSync(WORKFLOW, "utf8"));
  const jobStart = yaml.indexOf("version-pins:");
  const nextJob = yaml.indexOf("\n  freshness:", jobStart);
  const jobBlock = yaml.slice(jobStart, nextJob === -1 ? undefined : nextJob);
  assert.match(jobBlock, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(jobBlock, /issues:\s*write/);
});
