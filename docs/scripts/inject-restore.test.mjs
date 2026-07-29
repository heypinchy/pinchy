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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
  writeFileSync(
    path.join(snippetsDir, "cloud-init.yml"),
    "version: %%PINCHY_VERSION%%\n",
  );
  return { root, docsDir, srcDir };
}

function copyScripts(targetDocsDir) {
  const scriptsDir = path.join(targetDocsDir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const name of [
    "inject-version.sh",
    "restore-placeholders.sh",
    "with-restore.sh",
  ]) {
    const dest = path.join(scriptsDir, name);
    writeFileSync(dest, readFileSync(path.join(__dirname, name)), {
      mode: 0o755,
    });
  }
  return scriptsDir;
}

function runPipeline(scriptsDir, version) {
  const env = { ...process.env, PINCHY_VERSION: version };
  execFileSync("sh", [path.join(scriptsDir, "inject-version.sh")], {
    env,
    stdio: "ignore",
  });
  execFileSync("sh", [path.join(scriptsDir, "restore-placeholders.sh")], {
    env,
    stdio: "ignore",
  });
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

// ── with-restore.sh ───────────────────────────────────────────────────────
//
// `inject && astro build && restore` short-circuits: a failed build never
// restores, leaving vX.Y.Z baked into six committed docs source files, where
// the next `git commit -a` picks them up. The state is sticky, too — the next
// run finds no placeholders left to inject, so it registers nothing for the
// next restore to undo. with-restore.sh runs the restore either way and
// forwards the exit code, so a red build stays red without dirtying the tree.

function runWithRestore(scriptsDir, version, command) {
  const env = { ...process.env, PINCHY_VERSION: version };
  execFileSync("sh", [path.join(scriptsDir, "inject-version.sh")], {
    env,
    stdio: "ignore",
  });
  try {
    execFileSync("sh", [path.join(scriptsDir, "with-restore.sh"), ...command], {
      env,
      stdio: "ignore",
    });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test("with-restore.sh restores placeholders after a FAILING command", () => {
  const { root, srcDir } = setupDocsLikeTree();
  const scriptsDir = copyScripts(path.join(root, "docs"));

  const file = path.join(srcDir, "installation.mdx");
  const original = "Pinchy %%PINCHY_VERSION%% is out.\n";
  writeFileSync(file, original);

  const status = runWithRestore(scriptsDir, "v0.8.0", ["false"]);

  assert.equal(status, 1, "the failing command's exit code must survive");
  assert.equal(
    readFileSync(file, "utf-8"),
    original,
    "a failed build must not leave the injected version in the source tree",
  );

  rmSync(root, { recursive: true, force: true });
});

test("with-restore.sh fails when the restore itself fails", () => {
  // The whole point of the wrapper is that the source tree comes back clean.
  // A restore that failed and was reported as success is the original bug with
  // an extra step: vX.Y.Z stays in six committed files, and nothing says so.
  const { root, srcDir } = setupDocsLikeTree();
  const scriptsDir = copyScripts(path.join(root, "docs"));
  writeFileSync(
    path.join(scriptsDir, "restore-placeholders.sh"),
    "#!/bin/sh\nexit 3\n",
    { mode: 0o755 },
  );

  writeFileSync(
    path.join(srcDir, "installation.mdx"),
    "Pinchy %%PINCHY_VERSION%% is out.\n",
  );

  const status = runWithRestore(scriptsDir, "v0.8.0", ["true"]);

  assert.notEqual(status, 0, "a failed restore must not report success");

  rmSync(root, { recursive: true, force: true });
});

test("with-restore.sh restores placeholders after a SUCCEEDING command", () => {
  const { root, srcDir } = setupDocsLikeTree();
  const scriptsDir = copyScripts(path.join(root, "docs"));

  const file = path.join(srcDir, "installation.mdx");
  const original = "Pinchy %%PINCHY_VERSION%% is out.\n";
  writeFileSync(file, original);

  const status = runWithRestore(scriptsDir, "v0.8.0", ["true"]);

  assert.equal(status, 0);
  assert.equal(readFileSync(file, "utf-8"), original);

  rmSync(root, { recursive: true, force: true });
});
