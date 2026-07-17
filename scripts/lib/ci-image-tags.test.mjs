import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { builtImageTags, exportedImageTags } from "./ci-image-tags.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");

/** Writes a throwaway workflow file and returns its path. */
function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), "ci-image-tags-"));
  const path = join(dir, "ci.yml");
  writeFileSync(path, body);
  return path;
}

/** A minimal ci.yml shaped like the real one, with both sides in agreement. */
function workflow({ pushed, exported }) {
  return `name: CI
jobs:
  build-images:
    name: Build \${{ matrix.name }} image
    strategy:
      matrix:
        include:
          - name: Pinchy
            tag: ghcr.io/heypinchy/pinchy-ci
          - name: OpenClaw
            tag: ghcr.io/heypinchy/pinchy-openclaw-ci
    steps:
      - uses: docker/build-push-action@v7
        with:
          tags: ${pushed}

  build-image:
    steps:
      - id: tags
        run: |
${exported.map((e) => `          echo "${e}" >> $GITHUB_OUTPUT`).join("\n")}
`;
}

const IN_SYNC = {
  pushed: "${{ matrix.tag }}:sha-${{ github.sha }}",
  exported: [
    "pinchy=ghcr.io/heypinchy/pinchy-ci:sha-${{ github.sha }}",
    "openclaw=ghcr.io/heypinchy/pinchy-openclaw-ci:sha-${{ github.sha }}",
  ],
};

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test("builtImageTags resolves the matrix into one concrete tag per entry", () => {
  const path = fixture(workflow(IN_SYNC));
  assert.deepEqual(builtImageTags(path), [
    "ghcr.io/heypinchy/pinchy-ci:sha-${{ github.sha }}",
    "ghcr.io/heypinchy/pinchy-openclaw-ci:sha-${{ github.sha }}",
  ]);
});

test("exportedImageTags reads the fan-in's $GITHUB_OUTPUT values", () => {
  const path = fixture(workflow(IN_SYNC));
  assert.deepEqual(exportedImageTags(path), [
    "ghcr.io/heypinchy/pinchy-ci:sha-${{ github.sha }}",
    "ghcr.io/heypinchy/pinchy-openclaw-ci:sha-${{ github.sha }}",
  ]);
});

// ---------------------------------------------------------------------------
// Drift — the failure this guard exists for
// ---------------------------------------------------------------------------

// The regression in miniature: someone edits the tag scheme on ONE side. Every
// downstream job then pulls an image nobody pushed.
test("a tag scheme changed only in the builder is caught", () => {
  const path = fixture(workflow({ ...IN_SYNC, pushed: "${{ matrix.tag }}:${{ github.sha }}" }));
  assert.notDeepEqual(builtImageTags(path), exportedImageTags(path));
});

test("a tag scheme changed only in the fan-in is caught", () => {
  const path = fixture(
    workflow({
      ...IN_SYNC,
      exported: [
        "pinchy=ghcr.io/heypinchy/pinchy-ci:${{ github.sha }}",
        "openclaw=ghcr.io/heypinchy/pinchy-openclaw-ci:sha-${{ github.sha }}",
      ],
    })
  );
  assert.notDeepEqual(builtImageTags(path), exportedImageTags(path));
});

// A renamed GHCR repo on one side is the same class of break as a renamed tag.
test("a renamed image repo is caught", () => {
  const path = fixture(
    workflow({
      ...IN_SYNC,
      exported: [
        "pinchy=ghcr.io/heypinchy/pinchy-ci:sha-${{ github.sha }}",
        "openclaw=ghcr.io/heypinchy/openclaw-ci:sha-${{ github.sha }}",
      ],
    })
  );
  assert.notDeepEqual(builtImageTags(path), exportedImageTags(path));
});

// Dropping a matrix entry while the fan-in still advertises its tag would let
// downstream pull an image that is no longer built at all.
test("a builder that stops building one of the exported images is caught", () => {
  const path = fixture(
    `name: CI
jobs:
  build-images:
    strategy:
      matrix:
        include:
          - name: Pinchy
            tag: ghcr.io/heypinchy/pinchy-ci
    steps:
      - uses: docker/build-push-action@v7
        with:
          tags: \${{ matrix.tag }}:sha-\${{ github.sha }}

  build-image:
    steps:
      - id: tags
        run: |
          echo "pinchy=ghcr.io/heypinchy/pinchy-ci:sha-\${{ github.sha }}" >> $GITHUB_OUTPUT
          echo "openclaw=ghcr.io/heypinchy/pinchy-openclaw-ci:sha-\${{ github.sha }}" >> $GITHUB_OUTPUT
`
  );
  assert.notDeepEqual(builtImageTags(path), exportedImageTags(path));
});

test("a missing builder job is a loud error, not a silent pass", () => {
  const path = fixture("name: CI\njobs:\n  build-image:\n    steps: []\n");
  assert.throws(() => builtImageTags(path), /build-images/);
});

// ---------------------------------------------------------------------------
// The real ci.yml
// ---------------------------------------------------------------------------

test("ci.yml: the images build-images pushes are exactly the ones build-image exports", () => {
  assert.deepEqual(
    builtImageTags(CI_WORKFLOW),
    exportedImageTags(CI_WORKFLOW),
    "the `build-images` matrix and the `build-image` fan-in must name the same image tags — " +
      "downstream jobs pull what the fan-in exports, and nothing else checks that it was ever pushed"
  );
});
