import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { shardedJobs, shardDenominatorMismatches } from "./ci-sharding.mjs";
import { REQUIRED_JOBS } from "./ci-path-filter.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");

function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), "ci-sharding-"));
  const path = join(dir, "ci.yml");
  writeFileSync(path, body);
  return path;
}

/** A sharded job in ci.yml's shape. */
function shardedJob(name, { list, denominator }) {
  return `  ${name}:
    name: ${name} (\${{ matrix.shard }}/${denominator})
    strategy:
      fail-fast: false
      matrix:
        shard: [${list}]
    steps:
      - run: pnpm -C packages/web test:e2e --shard=\${{ matrix.shard }}/${denominator}
`;
}

// ---------------------------------------------------------------------------
// shardedJobs
// ---------------------------------------------------------------------------

test("shardedJobs finds jobs carrying a matrix, and only those", () => {
  const path = fixture(
    `name: CI
jobs:
${shardedJob("integration", { list: "1, 2", denominator: 2 })}
  quality:
    name: Lint, Test & Build
    steps:
      - run: pnpm test
`,
  );
  assert.deepEqual(shardedJobs(path), ["integration"]);
});

// ---------------------------------------------------------------------------
// shardDenominatorMismatches — the silent half
// ---------------------------------------------------------------------------

test("a matrix length matching its denominator is not an offender", () => {
  const path = fixture(
    `name: CI\njobs:\n${shardedJob("e2e-ish", { list: "1, 2", denominator: 2 })}`,
  );
  assert.deepEqual(shardDenominatorMismatches(path), []);
});

// The regression this guard exists for: someone raises the denominator to 3 and
// leaves the matrix at two entries. Shard 3 — a third of the suite — never runs,
// and BOTH jobs report green.
test("a denominator raised without extending the matrix is caught", () => {
  const path = fixture(
    `name: CI\njobs:\n${shardedJob("e2e-ish", { list: "1, 2", denominator: 3 })}`,
  );
  assert.deepEqual(shardDenominatorMismatches(path), [
    { jobName: "e2e-ish", matrixLength: 2, denominator: 3 },
  ]);
});

test("a matrix extended without raising the denominator is caught too", () => {
  const path = fixture(
    `name: CI\njobs:\n${shardedJob("e2e-ish", { list: "1, 2, 3", denominator: 2 })}`,
  );
  assert.deepEqual(shardDenominatorMismatches(path), [
    { jobName: "e2e-ish", matrixLength: 3, denominator: 2 },
  ]);
});

// The guard's own silent-failure mode. `shard:` written as a YAML block
// sequence is valid, identical in meaning, and what plenty of people write —
// but it is not the inline form the extractor recognises. Answering "no
// offenders" there would mean the guard stops guarding the moment someone
// reformats the matrix, which is the exact failure it exists to catch. A shard
// list it cannot read is UNCHECKABLE, not innocent, so it must be loud.
test("a shard matrix written as a block sequence is a loud error, not a silent pass", () => {
  const path = fixture(`name: CI
jobs:
  integration:
    strategy:
      matrix:
        shard:
          - 1
          - 2
    steps:
      - run: pnpm -C packages/web test:integration --shard=\${{ matrix.shard }}/3
`);
  assert.throws(() => shardDenominatorMismatches(path), /integration/);
});

// build-images matrixes over images, not shards — it has no denominator and must
// not be dragged into this check.
test("a matrix that is not a shard matrix is ignored", () => {
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
      - run: docker build .
`,
  );
  assert.deepEqual(shardDenominatorMismatches(path), []);
});

// ---------------------------------------------------------------------------
// The real ci.yml
// ---------------------------------------------------------------------------

// A matrix renames the status check, and branch protection matches by name — so
// sharding a required job leaves main waiting forever on a name that will never
// report again. Nothing in CI can catch that: the check simply stops existing.
test("ci.yml: no required check is sharded", () => {
  const sharded = shardedJobs(CI_WORKFLOW);
  const offenders = REQUIRED_JOBS.filter((name) => sharded.includes(name));
  assert.deepEqual(
    offenders,
    [],
    `these are required status checks — a matrix renames them to "<name> (1/2)" and branch protection ` +
      `would wait forever on a name that never reports, leaving main unmergeable: ${offenders.join(", ")}. ` +
      `Sharding one means changing branch protection in the same change.`,
  );
});

test("ci.yml: every sharded job's matrix length matches the denominator it passes to Playwright", () => {
  const offenders = shardDenominatorMismatches(CI_WORKFLOW);
  assert.deepEqual(
    offenders,
    [],
    `shard denominator disagrees with the matrix — the extra shard's tests never run and the job still ` +
      `reports green: ${offenders.map((o) => `${o.jobName} (matrix ${o.matrixLength}, --shard=…/${o.denominator})`).join(", ")}`,
  );
});
