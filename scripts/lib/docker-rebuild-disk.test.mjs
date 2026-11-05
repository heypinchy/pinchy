import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RECLAIM_ACTION,
  composeBuildsRootImage,
  composeFiles,
  jobsWithBuilds,
  pinnedBuildImageResult,
  rebuildDiskProblems,
} from "./docker-rebuild-disk.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const readRepoFile = (file) => {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

const COMPOSE = {
  "base.yml":
    "services:\n  pinchy:\n    image: ghcr.io/heypinchy/pinchy:latest\n",
  "root-build.yml":
    "services:\n  openclaw:\n    build:\n      context: .\n      dockerfile: Dockerfile.openclaw\n",
  "string-build.yml": "services:\n  pinchy:\n    build: .\n",
  "mock-build.yml":
    "services:\n  mock:\n    build:\n      context: config/mock\n",
  "override-tag.yml":
    'services:\n  pinchy:\n    ports: !override\n      - "1:1"\n    build:\n      context: .\n',
};
const readFixture = (file) => COMPOSE[file] ?? null;

function workflow(steps) {
  return `jobs:\n  job:\n    runs-on: ubuntu-latest\n    steps:\n${steps
    .map((s) => s.replace(/^/gm, "      "))
    .join("\n")}\n`;
}

const PULL = "- uses: ./.github/actions/pull-ci-images";
const RECLAIM = `- uses: ${RECLAIM_ACTION}`;
const DEV_BUILD =
  "- run: docker compose -f base.yml -f root-build.yml up --build -d";

const problems = (steps) =>
  rebuildDiskProblems("w.yml", workflow(steps), readFixture);

test("a pull followed by a rebuild is reported (the docker-smoke failure)", () => {
  const found = problems([PULL, DEV_BUILD]);
  assert.equal(found.length, 1);
  assert.match(found[0], /w\.yml:job step 2 .* step 1 .*reclaim-docker-disk/);
});

test("the reclaim action between them clears it", () => {
  assert.deepEqual(problems([PULL, RECLAIM, DEV_BUILD]), []);
});

test("the reclaim action is recognised however its path is spelled", () => {
  assert.deepEqual(
    problems([
      PULL,
      "- uses: ./.github/actions/reclaim-docker-disk/",
      DEV_BUILD,
    ]),
    [],
  );
});

test("a reclaim before the pull does not cover a build after it", () => {
  assert.equal(problems([RECLAIM, PULL, DEV_BUILD]).length, 1);
});

test("two plain docker builds in separate steps are reported", () => {
  const found = problems([
    "- run: docker build -t a -f Dockerfile.pinchy .",
    "- run: |\n    docker buildx build \\\n      -t b -f Dockerfile.openclaw .",
  ]);
  assert.equal(found.length, 1);
});

test("both builds in one step are not (the fork fallback shape)", () => {
  assert.deepEqual(
    problems([
      "- run: |\n    docker build -t a -f Dockerfile.pinchy .\n    docker build -t b -f Dockerfile.openclaw .",
    ]),
    [],
  );
});

test("a named docker pull counts as holding an image", () => {
  assert.equal(
    problems(["- run: docker pull ghcr.io/heypinchy/pinchy:v0.9.1", DEV_BUILD])
      .length,
    1,
  );
  assert.equal(
    problems(["- run: docker compose -f base.yml pull", DEV_BUILD]).length,
    1,
  );
});

test("steps pinned to different build-image results never both run", () => {
  assert.deepEqual(
    problems([
      `- if: needs.build-image.result == 'success'\n  uses: ./.github/actions/pull-ci-images`,
      `- if: needs.build-image.result == 'skipped'\n  run: docker build -t a .`,
    ]),
    [],
  );
});

test("an `||` in the condition does not count as exclusive", () => {
  assert.equal(
    pinnedBuildImageResult({
      if: "needs.build-image.result == 'success' || always()",
    }),
    null,
  );
  assert.equal(
    pinnedBuildImageResult({
      if: "steps.prev.outputs.skip == 'false' && needs.build-image.result == 'skipped'",
    }),
    "skipped",
  );
  assert.equal(
    problems([
      `- if: needs.build-image.result == 'success' || always()\n  uses: ./.github/actions/pull-ci-images`,
      `- if: needs.build-image.result == 'skipped'\n  run: docker build -t a .`,
    ]).length,
    1,
  );
});

test("a compose --build that builds only a mock is not a Pinchy build", () => {
  assert.deepEqual(
    problems([PULL, "- run: docker compose -f mock-build.yml up --build -d"]),
    [],
  );
});

test("compose builds from the repo root are recognised in every spelling", () => {
  assert.equal(composeBuildsRootImage(["string-build.yml"], readFixture), true);
  assert.equal(composeBuildsRootImage(["root-build.yml"], readFixture), true);
  assert.equal(composeBuildsRootImage(["override-tag.yml"], readFixture), true);
  assert.equal(composeBuildsRootImage(["base.yml"], readFixture), false);
  assert.equal(composeBuildsRootImage(["mock-build.yml"], readFixture), false);
});

test("compose files that cannot be read count as a Pinchy build", () => {
  assert.equal(composeBuildsRootImage(["$COMPOSE_FILES"], readFixture), true);
  assert.deepEqual(composeFiles("docker compose $COMPOSE_FILES up --build"), [
    "$unresolved",
  ]);
  assert.deepEqual(composeFiles("docker compose up --build"), [
    "docker-compose.yml",
  ]);
  assert.deepEqual(
    composeFiles('docker compose -f a.yml --file=b.yml -f "c.yml" up'),
    ["a.yml", "b.yml", "c.yml"],
  );
  assert.throws(
    () => composeBuildsRootImage(["missing.yml"], readFixture),
    /missing\.yml does not exist/,
  );
});

test("build-push-action holds a local image only with load: true", () => {
  const push = (load) =>
    `- uses: docker/build-push-action@v7\n  with:\n    push: true${load ? "\n    load: true" : ""}`;
  assert.deepEqual(problems([push(false), push(false)]), []);
  assert.equal(problems([push(true), push(false)]).length, 1);
});

test("unparseable YAML throws, naming the file", () => {
  assert.throws(
    () => rebuildDiskProblems("bad.yml", "jobs: [", readFixture),
    /bad\.yml: YAML does not parse/,
  );
});

test("no workflow builds a Pinchy image while another is on disk", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
  const found = files.flatMap((f) =>
    rebuildDiskProblems(
      `.github/workflows/${f}`,
      readFileSync(join(WORKFLOWS, f), "utf8"),
      readRepoFile,
    ),
  );
  assert.deepEqual(found, []);
});

test("the guard reads the real ci.yml's builds, docker-smoke among them", () => {
  // Corpus check: a parser that stopped finding builds would pass the sweep
  // above on nothing. docker-smoke is the job this guard was written for.
  const text = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
  const jobs = jobsWithBuilds("ci.yml", text, readRepoFile);
  assert.ok(jobs.includes("docker-smoke"), jobs.join(", "));
  assert.ok(jobs.length >= 10, `only ${jobs.length} building jobs found`);
});

test("removing docker-smoke's reclaim step is reported (canary)", () => {
  const text = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");
  const reclaim = `      - uses: ${RECLAIM_ACTION}\n`;
  assert.ok(
    text.includes(reclaim),
    "ci.yml no longer calls the reclaim action",
  );
  const found = rebuildDiskProblems(
    "ci.yml",
    text.replace(reclaim, ""),
    readRepoFile,
  );
  assert.equal(found.length, 1);
  assert.match(found[0], /ci\.yml:docker-smoke .*Start dev stack/);
});

test("a pull and a rebuild squeezed into one step are reported", () => {
  const found = problems([
    "- run: docker pull ghcr.io/heypinchy/pinchy:x && docker compose -f base.yml -f root-build.yml up --build -d",
  ]);
  assert.equal(found.length, 1);
  assert.match(found[0], /same step/);
});

test("a conditional reclaim clears nothing", () => {
  assert.equal(
    problems([
      PULL,
      `- if: needs.build-image.result == 'success'\n  uses: ${RECLAIM_ACTION}`,
      DEV_BUILD,
    ]).length,
    1,
  );
});

test("--build-arg alone is not a compose build", () => {
  assert.deepEqual(
    problems([
      PULL,
      "- run: docker compose -f root-build.yml up -d --build-arg X=1",
    ]),
    [],
  );
});

test("a reclaim with `if: always()` still clears", () => {
  assert.deepEqual(
    problems([PULL, `- if: always()\n  uses: ${RECLAIM_ACTION}`, DEV_BUILD]),
    [],
  );
});
