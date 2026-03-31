import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAndValidateVersion,
  bumpPackageJson,
  buildTagName,
  buildCommitMessage,
} from "./release-logic.mjs";

// parseAndValidateVersion

test("parseAndValidateVersion accepts valid semver", () => {
  assert.equal(parseAndValidateVersion("0.3.0"), "0.3.0");
});

test("parseAndValidateVersion strips leading v", () => {
  assert.equal(parseAndValidateVersion("v0.3.0"), "0.3.0");
});

test("parseAndValidateVersion rejects non-semver string", () => {
  assert.throws(() => parseAndValidateVersion("invalid"), /invalid version/i);
});

test("parseAndValidateVersion rejects incomplete semver", () => {
  assert.throws(() => parseAndValidateVersion("1.0"), /invalid version/i);
});

test("parseAndValidateVersion rejects empty string", () => {
  assert.throws(() => parseAndValidateVersion(""), /invalid version/i);
});

// bumpPackageJson

test("bumpPackageJson updates version field", () => {
  const input = JSON.stringify({ name: "pinchy", version: "0.2.0" }, null, 2);
  const output = bumpPackageJson(input, "0.3.0");
  assert.equal(JSON.parse(output).version, "0.3.0");
});

test("bumpPackageJson preserves other fields", () => {
  const input = JSON.stringify(
    { name: "pinchy", version: "0.2.0", private: true },
    null,
    2,
  );
  const output = bumpPackageJson(input, "0.3.0");
  const parsed = JSON.parse(output);
  assert.equal(parsed.name, "pinchy");
  assert.equal(parsed.private, true);
});

test("bumpPackageJson preserves trailing newline", () => {
  const input = '{"name":"pinchy","version":"0.2.0"}\n';
  const output = bumpPackageJson(input, "0.3.0");
  assert.ok(output.endsWith("\n"));
});

// buildTagName

test("buildTagName prefixes version with v", () => {
  assert.equal(buildTagName("0.3.0"), "v0.3.0");
});

// buildCommitMessage

test("buildCommitMessage follows conventional commit format", () => {
  assert.equal(buildCommitMessage("0.3.0"), "chore: release v0.3.0");
});
