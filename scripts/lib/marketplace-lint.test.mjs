import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findShellScripts,
  checkShellSyntax,
  assertValidPackerTemplate,
  assertValidCaproverTemplate,
} from "./marketplace-lint.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARKETPLACE = resolve(ROOT, "marketplace");
const TEMPLATE_PATH = resolve(MARKETPLACE, "digitalocean/template.json");
const CAPROVER_PATH = resolve(MARKETPLACE, "caprover/pinchy.yml");

// ─── Packer template structure ────────────────────────────────────────────────

test("assertValidPackerTemplate accepts a well-formed template", () => {
  const good = JSON.stringify({
    variables: { application_version: "v0.6.0" },
    builders: [{ type: "digitalocean" }],
    provisioners: [{ type: "shell" }],
  });
  assert.doesNotThrow(() => assertValidPackerTemplate(good));
});

test("assertValidPackerTemplate rejects invalid JSON", () => {
  assert.throws(
    () => assertValidPackerTemplate("{ not json"),
    /not valid JSON/,
  );
});

test("assertValidPackerTemplate rejects a non-version application_version", () => {
  const bad = JSON.stringify({
    variables: { application_version: "latest" },
    builders: [{ type: "digitalocean" }],
    provisioners: [{ type: "shell" }],
  });
  assert.throws(() => assertValidPackerTemplate(bad), /vX\.Y\.Z/);
});

test("assertValidPackerTemplate rejects a missing digitalocean builder", () => {
  const bad = JSON.stringify({
    variables: { application_version: "v0.6.0" },
    builders: [{ type: "amazon-ebs" }],
    provisioners: [{ type: "shell" }],
  });
  assert.throws(() => assertValidPackerTemplate(bad), /digitalocean builder/);
});

test("assertValidPackerTemplate rejects missing provisioners", () => {
  const bad = JSON.stringify({
    variables: { application_version: "v0.6.0" },
    builders: [{ type: "digitalocean" }],
  });
  assert.throws(() => assertValidPackerTemplate(bad), /provisioners/);
});

// ─── CapRover template invariants ─────────────────────────────────────────────

const GOOD_CAPROVER = `captainVersion: 4
services:
  $$cap_appname-db:
    image: postgres:17
  $$cap_appname-pinchy:
    environment:
      PINCHY_INTERNAL_URL: http://srv-captain--$$cap_appname-pinchy:7777
  $$cap_appname-openclaw:
    image: ghcr.io/heypinchy/pinchy-openclaw:$$cap_pinchy_version
caproverOneClickApp:
  variables:
    - id: $$cap_pinchy_version
      defaultValue: 'v0.6.0'
`;

test("assertValidCaproverTemplate accepts a well-formed template", () => {
  assert.doesNotThrow(() => assertValidCaproverTemplate(GOOD_CAPROVER));
});

test("assertValidCaproverTemplate rejects a template missing PINCHY_INTERNAL_URL", () => {
  // Regression guard: this exact field was missing in the first draft and would
  // have silently broken OpenClaw plugin callbacks on CapRover.
  const bad = GOOD_CAPROVER.replace(
    /PINCHY_INTERNAL_URL: .*/,
    "SOMETHING_ELSE: x",
  );
  assert.throws(() => assertValidCaproverTemplate(bad), /PINCHY_INTERNAL_URL/);
});

test("assertValidCaproverTemplate rejects a missing service", () => {
  const bad = GOOD_CAPROVER.replace(
    "$$cap_appname-openclaw",
    "$$cap_appname-typo",
  );
  assert.throws(() => assertValidCaproverTemplate(bad), /openclaw service/);
});

test("assertValidCaproverTemplate rejects a missing version pin", () => {
  const bad = GOOD_CAPROVER.replace(
    "defaultValue: 'v0.6.0'",
    "defaultValue: latest",
  );
  assert.throws(() => assertValidCaproverTemplate(bad), /version defaultValue/);
});

// ─── Real-file guards ─────────────────────────────────────────────────────────

test("the committed DigitalOcean template.json is structurally valid", () => {
  assert.doesNotThrow(() =>
    assertValidPackerTemplate(readFileSync(TEMPLATE_PATH, "utf8")),
  );
});

test("the committed CapRover pinchy.yml holds all critical invariants", () => {
  assert.doesNotThrow(() =>
    assertValidCaproverTemplate(readFileSync(CAPROVER_PATH, "utf8")),
  );
});

test("every shell script under marketplace/ passes bash -n", () => {
  const scripts = findShellScripts(MARKETPLACE);
  // Sanity: the DO image ships several scripts + the first-boot + MOTD files.
  assert.ok(
    scripts.length >= 6,
    `expected to find the marketplace shell scripts, found ${scripts.length}`,
  );
  for (const file of scripts) {
    assert.doesNotThrow(
      () => checkShellSyntax(file),
      `bash -n failed for ${file}`,
    );
  }
});
