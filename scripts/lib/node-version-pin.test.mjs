import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  parseNodeMajor,
  parseNvmrc,
  expectedEnginesRange,
  extractWorkflowNodeVersions,
  extractWorkflowNodeVersionFiles,
  extractDockerfileNodeVersions,
  validateNodeVersionPin,
} from "./node-version-pin.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("parseNvmrc reads a bare major, a full version, and a v prefix", () => {
  assert.deepEqual(parseNvmrc("22"), { major: 22 });
  assert.deepEqual(parseNvmrc("22.14.0\n"), { major: 22 });
  assert.deepEqual(parseNvmrc("v22.14.0"), { major: 22 });
});

test("parseNvmrc rejects an alias, which is drift wearing a pin's clothes", () => {
  // `lts/*` resolves to a different major as the calendar moves, so two
  // machines reading the same file can run different Node. That is the exact
  // failure the pin exists to prevent.
  const result = parseNvmrc("lts/*");
  assert.ok("error" in result);
  assert.match(result.error, /alias/i);
});

test("extractWorkflowNodeVersions finds plain, quoted, and interpolated values", () => {
  const yaml = [
    "      - uses: actions/setup-node@v6",
    "        with:",
    "          node-version: 22",
    "          node-version: '20'",
    '          node-version: "18"',
    "          node-version: ${{ matrix.node }}",
  ].join("\n");
  // The matrix reference comes back whole. Truncating it to "${{" would put a
  // string into the error message that appears nowhere in the file, so nobody
  // could grep for the line they are told to fix.
  assert.deepEqual(extractWorkflowNodeVersions(yaml), [
    "22",
    "20",
    "18",
    "${{ matrix.node }}",
  ]);
});

test("a major with an .x patch wildcard is a pin, not an alias", () => {
  // `node-version: 22.x` is the idiomatic setup-node spelling and names major
  // 22 as firmly as `22` does — minor drift never moves the ABI. Rejecting it
  // would fail a contributor for writing the conventional thing.
  assert.deepEqual(parseNodeMajor("22.x"), { major: 22 });
  assert.deepEqual(parseNodeMajor("22.14.x"), { major: 22 });

  // What must still be rejected is a spec whose MAJOR moves over time.
  assert.ok("error" in parseNodeMajor("lts/*"));
  assert.ok("error" in parseNodeMajor("node"));
});

test("a workflow pinning 22.x against .nvmrc 22 is coherent, not an error", () => {
  assert.deepEqual(
    validateNodeVersionPin({
      nvmrc: "22",
      enginesNode: ">=22 <23",
      workflows: [{ file: "ci.yml", versions: ["22.x"] }],
    }),
    [],
  );
});

test("extractWorkflowNodeVersionFiles sees a node-version-file declaration", () => {
  const yaml = [
    "        with:",
    "          node-version-file: .nvmrc",
    "          node-version-file: 'packages/web/.nvmrc'",
  ].join("\n");
  assert.deepEqual(extractWorkflowNodeVersionFiles(yaml), [
    ".nvmrc",
    "packages/web/.nvmrc",
  ]);
});

test("a workflow reading .nvmrc directly is the best case, and must pass", () => {
  // `node-version-file: .nvmrc` cannot drift — it IS the pin. A guard that
  // demanded a literal `node-version:` would fail the strictly better config.
  assert.deepEqual(
    validateNodeVersionPin({
      nvmrc: "22",
      enginesNode: ">=22 <23",
      workflows: [{ file: "ci.yml", versions: [], versionFiles: [".nvmrc"] }],
    }),
    [],
  );
});

test("a node-version-file pointing somewhere other than the root pin is flagged", () => {
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [
      { file: "ci.yml", versions: [], versionFiles: ["packages/web/.nvmrc"] },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /packages\/web\/\.nvmrc/);
});

test("extractDockerfileNodeVersions reads FROM lines and ignores everything else", () => {
  const dockerfile = [
    "# Pull node:24-slim via a mirror — a comment must not count as a pin.",
    "FROM mirror.gcr.io/library/node:22-slim AS base",
    "FROM base AS prod-deps",
    "FROM --platform=linux/amd64 node:22.14.0-bookworm AS build",
    "FROM mirror.gcr.io/library/postgres:17 AS db",
    "FROM node:22",
  ].join("\n");
  assert.deepEqual(extractDockerfileNodeVersions(dockerfile), [
    "22",
    "22.14.0",
    "22",
  ]);
});

test("a Dockerfile that drifts from .nvmrc names the file and both versions", () => {
  // The runtime image is where native modules are BUILT. A Dockerfile on a
  // different major than the pin reproduces the exact ABI mismatch this guard
  // was written for — in production rather than on a laptop.
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [{ file: "ci.yml", versions: ["22"] }],
    dockerfiles: [
      { file: "Dockerfile.pinchy", versions: ["22", "24"] },
      { file: "config/odoo-mock/Dockerfile", versions: ["22"] },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Dockerfile\.pinchy/);
  assert.match(errors[0], /24/);
  assert.match(errors[0], /22/);
});

test("a Dockerfile on a floating tag is rejected, since the major can move", () => {
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [],
    dockerfiles: [{ file: "Dockerfile.pinchy", versions: ["lts"] }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Dockerfile\.pinchy/);
});

test("a coherent pin produces no errors", () => {
  assert.deepEqual(
    validateNodeVersionPin({
      nvmrc: "22\n",
      enginesNode: ">=22 <23",
      workflows: [{ file: "ci.yml", versions: ["22"] }],
    }),
    [],
  );
});

test("a missing .nvmrc is reported on its own, without cascading", () => {
  const errors = validateNodeVersionPin({
    nvmrc: null,
    enginesNode: undefined,
    workflows: [{ file: "ci.yml", versions: ["22"] }],
  });
  // One message, not three: with no pin there is nothing for engines or the
  // workflows to disagree WITH, and three errors would bury the one fix.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /No \.nvmrc/);
});

test("an open-ended engines range is rejected, since it admits every future major", () => {
  // ">=22" is the tempting shape and the useless one: Node 25 satisfies it,
  // which is the version that produced the ABI mismatch behind this guard.
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22",
    workflows: [],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], />=22 <23/);
});

test("a workflow that drifts from .nvmrc names the file and both versions", () => {
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [
      { file: ".github/workflows/ci.yml", versions: ["22"] },
      { file: ".github/workflows/docs.yml", versions: ["24"] },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /docs\.yml/);
  assert.match(errors[0], /24/);
  assert.match(errors[0], /22/);
});

test("every node-version in a workflow is checked, not just the first", () => {
  // A workflow with several setup-node steps is the easy place to bump one and
  // miss another.
  const errors = validateNodeVersionPin({
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [{ file: "ci.yml", versions: ["22", "24"] }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /24/);
});

test("expectedEnginesRange bounds the major above as well as below", () => {
  assert.equal(expectedEnginesRange(22), ">=22 <23");
  assert.equal(expectedEnginesRange(9), ">=9 <10");
});

/** Every Dockerfile git tracks, with the node majors its FROM lines name. */
function readRepoDockerfiles() {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

  return tracked
    .filter((file) => /(^|\/)Dockerfile(\.[^/]+)?$/.test(file))
    .map((file) => ({
      file,
      versions: extractDockerfileNodeVersions(
        readFileSync(join(REPO_ROOT, file), "utf8"),
      ),
    }))
    .filter((entry) => entry.versions.length > 0);
}

test("a standalone package may raise the minor floor, never change the major", () => {
  // docs/ is not part of the workspace and has its own engines: astro 7 needs
  // >=22.22.0, a floor the root's `>=22 <23` does not state. That is a
  // legitimate narrowing. A second MAJOR is not — and nothing read this file
  // before, so a Node bump would have left docs/ on the old one in silence.
  const base = {
    nvmrc: "22",
    enginesNode: ">=22 <23",
    workflows: [],
  };
  for (const enginesNode of [">=22 <23", ">=22.22.0 <23"]) {
    assert.deepEqual(
      validateNodeVersionPin({
        ...base,
        packages: [{ file: "docs/package.json", enginesNode }],
      }),
      [],
      enginesNode,
    );
  }
  for (const enginesNode of [
    ">=22.22.0",
    ">=24 <25",
    ">=22.22.0 <24",
    undefined,
  ]) {
    const errors = validateNodeVersionPin({
      ...base,
      packages: [{ file: "docs/package.json", enginesNode }],
    });
    assert.equal(errors.length, 1, String(enginesNode));
    assert.match(errors[0], /docs\/package\.json/);
  }
});

// The assertion that matters: not that the validators work on fixtures, but
// that THIS repo is pinned coherently right now.
test("the repo pins one Node version across .nvmrc, engines, workflows, and images", () => {
  const nvmrcPath = join(REPO_ROOT, ".nvmrc");
  const nvmrc = existsSync(nvmrcPath) ? readFileSync(nvmrcPath, "utf8") : null;

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  const workflowDir = join(REPO_ROOT, ".github/workflows");
  const workflows = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => {
      const text = readFileSync(join(workflowDir, name), "utf8");
      return {
        file: `.github/workflows/${name}`,
        versions: extractWorkflowNodeVersions(text),
        versionFiles: extractWorkflowNodeVersionFiles(text),
      };
    });

  const dockerfiles = readRepoDockerfiles();

  // Standalone packages with their own lockfile (not workspace members) state
  // their own engines and are read here, or a Node bump leaves them behind.
  const packages = ["docs/package.json"].map((file) => ({
    file,
    enginesNode: JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")).engines
      ?.node,
  }));

  // Guards the guard: if setup-node disappears from every workflow, or the
  // Dockerfiles stop naming a node image, the loops below have nothing to
  // compare and would pass vacuously.
  assert.ok(
    workflows.some((w) => w.versions.length > 0 || w.versionFiles.length > 0),
    "no workflow declares a Node version — this check would pass without checking anything",
  );
  assert.ok(
    dockerfiles.length > 0,
    "no Dockerfile names a node image — this check would pass without checking anything",
  );

  const errors = validateNodeVersionPin({
    nvmrc,
    enginesNode: pkg.engines?.node,
    workflows,
    dockerfiles,
    packages,
  });
  assert.deepEqual(errors, [], errors.join("\n"));
});
