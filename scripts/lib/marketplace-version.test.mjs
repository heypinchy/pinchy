import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPinchyVersionFromEnv,
  readMarketplaceVersion,
  bumpMarketplaceVersion,
  assertMarketplaceVersionInSync,
} from "./marketplace-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE_PATH = resolve(ROOT, "marketplace/digitalocean/template.json");
const ENV_EXAMPLE_PATH = resolve(ROOT, ".env.example");
const RELEASE_MJS = resolve(ROOT, "scripts/release.mjs");

const SAMPLE_TEMPLATE = JSON.stringify(
  {
    variables: { application_name: "Pinchy", application_version: "v0.5.8" },
    builders: [{ type: "digitalocean" }],
  },
  null,
  2,
);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test("readPinchyVersionFromEnv extracts the pinned version", () => {
  assert.equal(
    readPinchyVersionFromEnv("FOO=bar\nPINCHY_VERSION=v0.6.0\nBAZ=qux\n"),
    "v0.6.0",
  );
});

test("readPinchyVersionFromEnv throws when the line is absent", () => {
  assert.throws(() => readPinchyVersionFromEnv("FOO=bar\n"), /PINCHY_VERSION/);
});

test("readMarketplaceVersion reads variables.application_version", () => {
  assert.equal(readMarketplaceVersion(SAMPLE_TEMPLATE), "v0.5.8");
});

test("readMarketplaceVersion throws when the field is missing", () => {
  assert.throws(
    () => readMarketplaceVersion('{"variables":{}}'),
    /application_version/,
  );
});

test("bumpMarketplaceVersion sets application_version with a v prefix", () => {
  const bumped = bumpMarketplaceVersion(SAMPLE_TEMPLATE, "0.6.0");
  assert.equal(readMarketplaceVersion(bumped), "v0.6.0");
});

test("bumpMarketplaceVersion preserves a trailing newline", () => {
  assert.ok(
    bumpMarketplaceVersion(SAMPLE_TEMPLATE + "\n", "0.6.0").endsWith("\n"),
  );
  assert.ok(!bumpMarketplaceVersion(SAMPLE_TEMPLATE, "0.6.0").endsWith("\n"));
});

test("bumpMarketplaceVersion leaves other fields untouched", () => {
  const bumped = JSON.parse(bumpMarketplaceVersion(SAMPLE_TEMPLATE, "0.6.0"));
  assert.equal(bumped.variables.application_name, "Pinchy");
  assert.equal(bumped.builders[0].type, "digitalocean");
});

test("bumpMarketplaceVersion throws on a template without the field", () => {
  assert.throws(
    () => bumpMarketplaceVersion('{"variables":{}}', "0.6.0"),
    /application_version/,
  );
});

test("assertMarketplaceVersionInSync passes when versions match", () => {
  assert.doesNotThrow(() =>
    assertMarketplaceVersionInSync(SAMPLE_TEMPLATE, "PINCHY_VERSION=v0.5.8\n"),
  );
});

test("assertMarketplaceVersionInSync throws when versions differ", () => {
  assert.throws(
    () =>
      assertMarketplaceVersionInSync(
        SAMPLE_TEMPLATE,
        "PINCHY_VERSION=v0.6.0\n",
      ),
    /out of sync/,
  );
});

// ─── Real-file drift guard ────────────────────────────────────────────────────
// The committed DigitalOcean template must always pin the same version as
// .env.example. `pnpm release` bumps both; this fails a PR the moment they drift.

test("the DigitalOcean template version matches .env.example PINCHY_VERSION", () => {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const envExample = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  assert.doesNotThrow(() =>
    assertMarketplaceVersionInSync(template, envExample),
  );
});

// ─── Release-script wiring guard ──────────────────────────────────────────────
// The drift guard only protects us if `pnpm release` actually bumps the
// marketplace template. These textual sweeps fail if a refactor drops the bump.

test("release.mjs bumps the marketplace template version", () => {
  const src = readFileSync(RELEASE_MJS, "utf8");
  assert.match(
    src,
    /bumpMarketplaceVersion/,
    "release.mjs must call bumpMarketplaceVersion so the DO template tracks the release",
  );
  assert.match(
    src,
    /marketplace\/digitalocean\/template\.json/,
    "release.mjs must write the DigitalOcean template.json on release",
  );
});

test("release.mjs commits the marketplace template", () => {
  const src = readFileSync(RELEASE_MJS, "utf8");
  // The single `git add` line in release.mjs must include the template so the
  // bump lands in the release commit rather than as a dangling local change.
  const addLine = src
    .split("\n")
    .find((l) => l.includes("git add") && l.includes("package.json"));
  assert.ok(addLine, "release.mjs has no 'git add … package.json' line");
  assert.match(
    addLine,
    /marketplace\/digitalocean\/template\.json/,
    "the release commit's `git add` must include the DigitalOcean template.json",
  );
});
