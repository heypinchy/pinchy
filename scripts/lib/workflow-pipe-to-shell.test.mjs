import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { findPipedDownloads } from "./workflow-pipe-to-shell.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("flags a download piped straight into sh", () => {
  const text = [
    "      - run: |",
    "          if curl -fsSL https://ollama.com/install.sh | sh; then exit 0; fi",
  ].join("\n");
  const found = findPipedDownloads(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test("flags every shell spelling, with sudo, flags and env prefixes", () => {
  for (const tail of [
    "| bash",
    "| bash -s -- --yes",
    "|sh",
    "| sudo sh",
    "| sudo -E bash -",
    "| zsh",
    "| dash",
    "| env FOO=1 sh",
    "| FOO=1 sh",
    "| /bin/sh",
    "| /usr/bin/env bash",
  ]) {
    for (const fetcher of [
      "curl -fsSL https://x.test/i.sh",
      "wget -qO- https://x.test/i.sh",
    ]) {
      const text = `        run: ${fetcher} ${tail}`;
      assert.equal(findPipedDownloads(text).length, 1, `missed: ${text}`);
    }
  }
});

test("flags a pipe through an intermediate stage into a shell", () => {
  const text = "        run: curl -fsSL https://x.test/i.sh | tee i.sh | sh";
  assert.equal(findPipedDownloads(text).length, 1);
});

test("follows a backslash continuation onto the shell", () => {
  const text = [
    "        run: |",
    "          curl -fsSL https://x.test/i.sh \\",
    "            | sh",
  ].join("\n");
  const found = findPipedDownloads(text);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test("leaves the download-then-run shape alone", () => {
  const text = [
    "        run: |",
    '          curl -fsSL -o "$RUNNER_TEMP/i.sh" https://x.test/i.sh',
    '          sh "$RUNNER_TEMP/i.sh"',
    "          curl -fsSL https://x.test/a.json | jq .version",
    "          curl -sf http://localhost:11434/api/tags >/dev/null || exit 1",
    "          curl -fsSL https://x.test/a.tgz | tar -xz",
  ].join("\n");
  assert.deepEqual(findPipedDownloads(text), []);
});

test("an `||` fallback is not a pipe into a shell", () => {
  const text =
    "        run: curl -fsSL https://x.test/health || sh ./fallback.sh";
  assert.deepEqual(findPipedDownloads(text), []);
});

test("does not read a comment as the command", () => {
  const text = [
    "        # Never `curl … | sh` here: a 504 feeds sh an empty script.",
    "        run: |",
    "          # curl -fsSL https://x.test/i.sh | sh",
    "          echo ok # was: curl https://x.test/i.sh | sh",
  ].join("\n");
  assert.deepEqual(findPipedDownloads(text), []);
});

/** Every file GitHub runs shell from in this repo: the workflows and the
 * local composite actions. */
function workflowFiles() {
  const files = [];
  const wfDir = join(REPO_ROOT, ".github/workflows");
  for (const f of readdirSync(wfDir)) {
    if (/\.ya?ml$/.test(f)) files.push(join(wfDir, f));
  }
  const actionsDir = join(REPO_ROOT, ".github/actions");
  for (const d of readdirSync(actionsDir)) {
    for (const name of ["action.yml", "action.yaml"]) {
      const p = join(actionsDir, d, name);
      if (existsSync(p)) files.push(p);
    }
  }
  return files;
}

test("no workflow or composite action pipes a download into a shell", () => {
  const files = workflowFiles();
  // Corpus floor: a broken directory walk must not pass on an empty sweep.
  assert.ok(
    files.length >= 14,
    `expected >= 14 workflow/action files, found ${files.length}`,
  );
  const problems = [];
  for (const file of files) {
    for (const hit of findPipedDownloads(readFileSync(file, "utf8"))) {
      problems.push(
        `${relative(REPO_ROOT, file)}:${hit.line}: ${hit.text.trim()}`,
      );
    }
  }
  assert.deepEqual(
    problems,
    [],
    "A download piped into a shell succeeds when the download fails: `curl -f` exits " +
      "non-zero, but without pipefail the pipeline reports sh's status, and sh exits 0 " +
      "on an empty (or truncated) script. Download to a file with `curl -fsSL -o`, then " +
      "run the file, then check the result exists.\n" +
      problems.join("\n"),
  );
});
