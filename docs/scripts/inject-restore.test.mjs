// Regression test for the inject-version → restore-placeholders pipeline.
//
// Bug: a naive `sed s/v$TAG/%%PINCHY_VERSION%%/g` restore step destroys
// legitimate historical occurrences of `vX.Y.Z` in the source files
// (e.g. the `## Upgrading from v0.5.3 to %%PINCHY_VERSION%%` heading)
// whenever the injected version equals one of those historical references.
//
// The pipeline must be reversible: source files after build must match
// source files before build, byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INJECT = path.join(__dirname, "inject-version.sh");
const RESTORE = path.join(__dirname, "restore-placeholders.sh");

function setupDocsLikeTree() {
  const root = mkdtempSync(path.join(tmpdir(), "pinchy-docs-test-"));
  const docsDir = path.join(root, "docs");
  const srcDir = path.join(docsDir, "src");
  const publicDir = path.join(docsDir, "public");
  const snippetsDir = path.join(srcDir, "snippets");
  mkdirSync(snippetsDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  // Required by inject-version.sh to write public/cloud-init.yml.
  writeFileSync(path.join(snippetsDir, "cloud-init.yml"), "version: %%PINCHY_VERSION%%\n");
  return { root, docsDir, srcDir };
}

function copyScripts(targetDocsDir) {
  const scriptsDir = path.join(targetDocsDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const name of ["inject-version.sh", "restore-placeholders.sh"]) {
    const dest = path.join(scriptsDir, name);
    writeFileSync(dest, readFileSync(path.join(__dirname, name)), { mode: 0o755 });
  }
  return scriptsDir;
}

function runPipeline(scriptsDir, version) {
  const env = { ...process.env, PINCHY_VERSION: version };
  execFileSync("sh", [path.join(scriptsDir, "inject-version.sh")], { env, stdio: "ignore" });
  execFileSync("sh", [path.join(scriptsDir, "restore-placeholders.sh")], { env, stdio: "ignore" });
}

test("inject + restore round-trip preserves historical version references", () => {
  const { root, srcDir } = setupDocsLikeTree();
  const scriptsDir = copyScripts(path.join(root, "docs"));

  const file = path.join(srcDir, "upgrading.mdx");
  const original = [
    "## Upgrading from v0.5.3 to %%PINCHY_VERSION%%",
    "",
    "Bump with:",
    "",
    "```bash",
    "sed -i 's/PINCHY_VERSION=v0.5.3/PINCHY_VERSION=%%PINCHY_VERSION%%/' .env",
    "```",
    "",
    "## Upgrading from v0.5.2 to v0.5.3",
    "",
    "v0.5.3 was a maintenance release.",
    "",
  ].join("\n");
  writeFileSync(file, original);

  runPipeline(scriptsDir, "v0.5.3");

  const restored = readFileSync(file, "utf-8");
  assert.equal(
    restored,
    original,
    "inject+restore must round-trip; historical v0.5.3 occurrences must NOT be replaced with %%PINCHY_VERSION%%",
  );

  rmSync(root, { recursive: true, force: true });
});

test("inject + restore round-trip preserves a heading that names the current version", () => {
  const { root, srcDir } = setupDocsLikeTree();
  const scriptsDir = copyScripts(path.join(root, "docs"));

  const file = path.join(srcDir, "release-notes.md");
  const original = "# Release v0.5.3\n\nLatest version: %%PINCHY_VERSION%%.\n";
  writeFileSync(file, original);

  runPipeline(scriptsDir, "v0.5.3");

  const restored = readFileSync(file, "utf-8");
  assert.equal(restored, original);

  rmSync(root, { recursive: true, force: true });
});
