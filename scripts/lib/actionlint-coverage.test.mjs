import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  ACCEPTED_UNCHECKED,
  MIN_EXPECTED_ACTIONS,
  PROBE_INPUT,
  buildProbeWorkflow,
  classifyCoverage,
  extractActionRefs,
  formatFailure,
  isReusableWorkflowRef,
  probeReportedInput,
} from "./actionlint-coverage.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function collectYaml(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectYaml(full));
    else if (/\.ya?ml$/.test(entry))
      out.push({ path: full, content: readFileSync(full, "utf8") });
  }
  return out;
}

test("extractActionRefs finds remote refs in the shapes workflows actually use", () => {
  const refs = extractActionRefs([
    {
      path: "w.yml",
      content: [
        "      - uses: actions/checkout@v7",
        "        uses: docker/build-push-action@v7",
        '      - uses: "docker/login-action@v4"',
        "      - uses: github/codeql-action/init@v4 # subpath action",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(refs, [
    "actions/checkout@v7",
    "docker/build-push-action@v7",
    "docker/login-action@v4",
    "github/codeql-action/init@v4",
  ]);
});

test("extractActionRefs skips refs actionlint cannot input-check anyway", () => {
  // Local composite actions and reusable workflows get no input validation
  // (verified with a probe), so listing them would only produce acceptances
  // that assert nothing. `docker://` is not an action at all.
  const refs = extractActionRefs([
    {
      path: "w.yml",
      content: [
        "      - uses: ./.github/actions/docker-mirror",
        "    uses: ./.github/workflows/screenshots.yml",
        "      - uses: docker://alpine:3.20",
        "      - uses: actions/cache@v5",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(refs, ["actions/cache@v5"]);
});

test("extractActionRefs dedupes across files and sorts", () => {
  const refs = extractActionRefs([
    { path: "a.yml", content: "      - uses: actions/checkout@v7" },
    { path: "b.yml", content: "      - uses: actions/cache@v5" },
    { path: "c.yml", content: "      - uses: actions/checkout@v7" },
  ]);
  assert.deepEqual(refs, ["actions/cache@v5", "actions/checkout@v7"]);
});

test("extractActionRefs finds a quoted job-level remote reusable workflow", () => {
  // The shape a hand-written grep misses: quoted, at job level, with `.yml@`
  // in the middle of the ref. ci.yml's osv-scanner job is exactly this, and it
  // was missing from the first enumeration of this repo's actions.
  const refs = extractActionRefs([
    {
      path: "ci.yml",
      content:
        '    uses: "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.8"',
    },
  ]);
  assert.deepEqual(refs, [
    "google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.8",
  ]);
});

test("buildProbeWorkflow carries the probe input under the given action", () => {
  const yaml = buildProbeWorkflow("docker/setup-buildx-action@v4");
  assert.match(yaml, /uses: docker\/setup-buildx-action@v4/);
  assert.match(yaml, new RegExp(`${PROBE_INPUT}: "x"`));
  assert.match(yaml, /runs-on: ubuntu-latest/);
  assert.match(yaml, /steps:/);
});

test("buildProbeWorkflow probes a reusable workflow at job level, not as a step", () => {
  // A reusable workflow used as a step is illegal YAML-for-Actions, so the
  // probe would read "unchecked" because it is malformed rather than because
  // actionlint is silent — an acceptance resting on a broken measurement.
  const ref = "o/r/.github/workflows/w.yml@v1";
  assert.equal(isReusableWorkflowRef(ref), true);
  assert.equal(isReusableWorkflowRef("docker/login-action@v4"), false);

  const yaml = buildProbeWorkflow(ref);
  assert.doesNotMatch(yaml, /steps:/);
  assert.doesNotMatch(yaml, /runs-on:/);
  assert.match(
    yaml,
    new RegExp(`^ {4}uses: ${ref.replace(/\//g, "\\/")}$`, "m"),
  );
  assert.match(yaml, new RegExp(`^ {6}${PROBE_INPUT}: "x"$`, "m"));
});

test("probeReportedInput keys on the input name, not on the exit code", () => {
  // actionlint may report unrelated things about a synthetic workflow; an exit
  // code cannot tell those apart from the answer we want.
  assert.equal(
    probeReportedInput(
      `probe.yml:9:11: input "${PROBE_INPUT}" is not defined in action "x" [action]`,
    ),
    true,
  );
  assert.equal(
    probeReportedInput('probe.yml:5:5: "runs-on" is not valid [runner-label]'),
    false,
  );
  assert.equal(probeReportedInput(""), false);
});

test("classifyCoverage fails on an action nothing validates and nothing accepts", () => {
  const used = Array.from({ length: 12 }, (_, i) => `o/r${i}@v1`);
  const { failures } = classifyCoverage({
    used,
    checked: used.slice(1),
    accepted: {},
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /o\/r0@v1/);
  assert.match(failures[0], /ACCEPTED_UNCHECKED/);
});

test("classifyCoverage passes when the gap is accepted with a reason", () => {
  const used = Array.from({ length: 12 }, (_, i) => `o/r${i}@v1`);
  const { failures } = classifyCoverage({
    used,
    checked: used.slice(1),
    accepted: { "o/r0@v1": "not in actionlint's DB at any version" },
  });
  assert.deepEqual(failures, []);
});

test("classifyCoverage rejects an acceptance with no reason", () => {
  const used = Array.from({ length: 12 }, (_, i) => `o/r${i}@v1`);
  const { failures } = classifyCoverage({
    used,
    checked: used.slice(1),
    accepted: { "o/r0@v1": "   " },
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no reason/);
});

test("classifyCoverage fails when an acceptance outlives its evidence", () => {
  const used = Array.from({ length: 12 }, (_, i) => `o/r${i}@v1`);

  // actionlint caught up and now checks it.
  const nowChecked = classifyCoverage({
    used,
    checked: used,
    accepted: { "o/r0@v1": "was unchecked" },
  });
  assert.equal(nowChecked.failures.length, 1);
  assert.match(nowChecked.failures[0], /but it now does/);

  // The action (at that version) is gone from the workflows.
  const gone = classifyCoverage({
    used,
    checked: used,
    accepted: { "o/removed@v9": "was unchecked" },
  });
  assert.equal(gone.failures.length, 1);
  assert.match(gone.failures[0], /no workflow uses/);
});

test("classifyCoverage fails on an empty corpus rather than passing in silence", () => {
  // A broken extractor is the one mutation every other assertion here is blind
  // to: zero actions means zero coverage failures, i.e. a green decoration.
  const { failures } = classifyCoverage({
    used: [],
    checked: [],
    accepted: {},
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /expected at least/);
});

test("formatFailure names every failure", () => {
  const text = formatFailure(["first thing", "second thing"]);
  assert.match(text, /first thing/);
  assert.match(text, /second thing/);
});

test("every ACCEPTED_UNCHECKED entry is an action this repo still uses", () => {
  // The half of the both-directions rule that can be checked without the
  // binary: an acceptance naming a ref no workflow contains is stale on its
  // face, and would otherwise only surface in CI.
  const used = new Set(
    extractActionRefs(collectYaml(join(REPO_ROOT, ".github"))),
  );
  assert.ok(
    used.size >= MIN_EXPECTED_ACTIONS,
    `expected at least ${MIN_EXPECTED_ACTIONS} action refs under .github/, found ${used.size}`,
  );
  for (const [ref, reason] of Object.entries(ACCEPTED_UNCHECKED)) {
    assert.ok(
      used.has(ref),
      `ACCEPTED_UNCHECKED names ${ref}, which no workflow under .github/ uses`,
    );
    assert.ok(reason.trim().length > 0, `${ref} has no reason`);
  }
});

test("ci.yml runs the coverage check with the actionlint it just verified", () => {
  // The wiring assertion. A coverage guard nothing invokes is the failure mode
  // it exists to prevent, one level up.
  const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /scripts\/check-actionlint-coverage\.mjs/);
  assert.match(
    ci,
    /ACTIONLINT_BIN:\s*\$\{\{\s*runner\.temp\s*\}\}\/actionlint/,
    "the check must run the pinned binary, not whatever the runner image ships",
  );
});
