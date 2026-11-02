import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compositeMirrorProblems,
  mirrorLoginProblems,
  mirrorReferenceMismatch,
  parseMirrorJobs,
} from "./docker-mirror-guard.mjs";

// Behavior tests + wiring guard for the docker-mirror pre-pull. The action
// pulls Docker Hub images from mirror.gcr.io to stay off docker.io's rate
// limit, and a single transient mirror miss used to fail the whole job —
// three CI runs in one afternoon died on errors like
//
//   failed to copy: httpReadSeeker: failed open: could not fetch content
//   descriptor sha256:… (application/vnd.in-toto+json) from remote: not found
//
// The pull logic lives in a standalone script inside the composite action so
// it can be exercised here against a stub `docker` binary — same approach as
// pull-ci-images-retry.test.mjs.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTION_DIR = join(ROOT, ".github", "actions", "docker-mirror");
const SCRIPT = join(ACTION_DIR, "pull-via-mirror.sh");
const ACTION_YML = join(ACTION_DIR, "action.yml");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const ACTIONS_DIR = join(ROOT, ".github", "actions");

// The exact shape of the observed failure. It says "not found", which is
// why the mirror path must NOT reuse pull-ci-images' "not found means
// deterministic, don't retry" classification: on the mirror, it is the
// transient case.
const MIRROR_MISS_ERROR =
  "failed to copy: httpReadSeeker: failed open: could not fetch content descriptor sha256:0123abcd (application/vnd.in-toto+json) from remote: not found";

/**
 * Runs the script against a stub `docker` on PATH. The stub fails the first
 * `mirrorFailTimes` pulls of each mirror.gcr.io ref with a mirror-miss error,
 * fails every docker.io pull when `hubFails` is set, and records every call
 * so tests can assert exactly what was pulled and tagged.
 *
 * `backoff` sets MIRROR_PULL_BACKOFF_SECONDS; pass `null` to leave it unset
 * and exercise the script's own default. A stub `sleep` on PATH records its
 * arguments into the same call log (as `sleep <n>`) and returns at once, so
 * the production backoff can be asserted without sitting through it.
 */
function runScript({
  images,
  mirrorFailTimes = 0,
  hubFails = false,
  backoff = "0 0",
}) {
  const stubDir = mkdtempSync(join(tmpdir(), "docker-mirror-stub-"));
  const stub = join(stubDir, "docker");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls"
case "$1" in
  tag) exit 0 ;;
  pull) ;;
  *) echo "stub docker: unexpected subcommand $1" >&2; exit 64 ;;
esac
case "$2" in
  mirror.gcr.io/*)
    key=$(printf '%s' "$2" | tr -c 'a-zA-Z0-9' '_')
    count_file="$STUB_DIR/count-$key"
    count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$count" > "$count_file"
    if [ "$count" -le "$MIRROR_FAIL_TIMES" ]; then
      echo "$MIRROR_MISS_ERROR" >&2
      exit 1
    fi
    ;;
  *)
    if [ "$HUB_FAILS" = "1" ]; then
      echo "toomanyrequests: You have reached your pull rate limit." >&2
      exit 1
    fi
    ;;
esac
exit 0
`,
  );
  chmodSync(stub, 0o755);
  const sleepStub = join(stubDir, "sleep");
  writeFileSync(
    sleepStub,
    `#!/usr/bin/env bash
echo "sleep $*" >> "$STUB_DIR/calls"
`,
  );
  chmodSync(sleepStub, 0o755);

  const env = {
    ...process.env,
    PATH: `${stubDir}:${process.env.PATH}`,
    STUB_DIR: stubDir,
    MIRROR_FAIL_TIMES: String(mirrorFailTimes),
    MIRROR_MISS_ERROR,
    HUB_FAILS: hubFails ? "1" : "0",
  };
  delete env.MIRROR_PULL_BACKOFF_SECONDS;
  if (backoff !== null) env.MIRROR_PULL_BACKOFF_SECONDS = backoff;

  const result = spawnSync("bash", [SCRIPT, ...images], {
    encoding: "utf8",
    env,
  });

  const callsFile = join(stubDir, "calls");
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { result, calls };
}

test("pulls a library image from mirror.gcr.io/library and retags it", () => {
  const { result, calls } = runScript({ images: ["caddy:2"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "pull mirror.gcr.io/library/caddy:2",
    "tag mirror.gcr.io/library/caddy:2 caddy:2",
  ]);
});

test("pulls a namespaced image from mirror.gcr.io/<namespace> and retags it", () => {
  const { result, calls } = runScript({ images: ["pgvector/pgvector:pg17"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "pull mirror.gcr.io/pgvector/pgvector:pg17",
    "tag mirror.gcr.io/pgvector/pgvector:pg17 pgvector/pgvector:pg17",
  ]);
});

test("retries a transient mirror miss (even one saying 'not found') and never touches docker.io", () => {
  const { result, calls } = runScript({
    images: ["caddy:2"],
    mirrorFailTimes: 2,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "pull mirror.gcr.io/library/caddy:2",
    "sleep 0",
    "pull mirror.gcr.io/library/caddy:2",
    "sleep 0",
    "pull mirror.gcr.io/library/caddy:2",
    "tag mirror.gcr.io/library/caddy:2 caddy:2",
  ]);
  assert.ok(result.stdout.includes("attempt 1/3"));
  assert.ok(result.stdout.includes("attempt 2/3"));
  // GitHub keeps only ~10 annotations per step. A retry that recovered is
  // log detail, not an annotation — spending the budget on it is how the
  // fallback warning that does matter gets dropped during an outage.
  assert.ok(
    !result.stdout.includes("::warning::"),
    "a retry that recovers must not emit annotations",
  );
});

test("uses the production backoff (10s, then 30s) when MIRROR_PULL_BACKOFF_SECONDS is unset", () => {
  const { result, calls } = runScript({
    images: ["caddy:2"],
    mirrorFailTimes: 99,
    backoff: null,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    "pull mirror.gcr.io/library/caddy:2",
    "sleep 10",
    "pull mirror.gcr.io/library/caddy:2",
    "sleep 30",
    "pull mirror.gcr.io/library/caddy:2",
    "pull caddy:2",
  ]);
});

test("falls back to docker.io only after all mirror attempts fail, with a warning naming the image", () => {
  const { result, calls } = runScript({
    images: ["caddy:2"],
    mirrorFailTimes: 99,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.filter((call) => !call.startsWith("sleep ")),
    [
      "pull mirror.gcr.io/library/caddy:2",
      "pull mirror.gcr.io/library/caddy:2",
      "pull mirror.gcr.io/library/caddy:2",
      "pull caddy:2",
    ],
  );
  const annotations = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("::"));
  assert.equal(
    annotations.length,
    1,
    `the fallback must be the only annotation, so the per-step cap cannot drop it; got:\n${annotations.join("\n")}`,
  );
  const [fallbackWarning] = annotations;
  assert.ok(fallbackWarning.startsWith("::warning::"));
  assert.ok(fallbackWarning.includes("docker.io"));
  assert.ok(
    fallbackWarning.includes("caddy:2"),
    "the fallback warning must name the image",
  );
  // Jobs that never log in to Docker Hub (screenshots.yml) make this an
  // anonymous pull with the tighter anonymous limit, and even an
  // authenticated one can be rate-limited. The warning must not promise more.
  assert.match(fallbackWarning, /anonymous/i);
  assert.match(fallbackWarning, /rate.limit/i);
});

test("fails with a ::error:: naming the image when mirror and docker.io both fail", () => {
  const { result, calls } = runScript({
    images: ["caddy:2", "postgres:17"],
    mirrorFailTimes: 99,
    hubFails: true,
  });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("::error::"));
  assert.ok(result.stdout.includes("caddy:2"));
  assert.ok(
    !calls.some((call) => call.includes("postgres")),
    "must stop at the first image that cannot be pulled from anywhere",
  );
});

test("a fallback for one image does not stop the next image from using the mirror", () => {
  const { result, calls } = runScript({
    images: ["caddy:2", "pgvector/pgvector:pg17"],
    mirrorFailTimes: 99,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.includes("pull caddy:2"));
  assert.ok(calls.includes("pull mirror.gcr.io/pgvector/pgvector:pg17"));
});

test("rejects a call without images instead of silently succeeding", () => {
  const { result } = runScript({ images: [] });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("::error::"));
});

// Wiring guard: the tested script only protects CI if the action routes every
// mirror pull through it. A bare `docker pull mirror.gcr.io/...` in action.yml
// would be the untested, retry-less path this change replaced.
test("the docker-mirror action pulls only through pull-via-mirror.sh", () => {
  const action = readFileSync(ACTION_YML, "utf8");
  assert.ok(
    action.includes('"$GITHUB_ACTION_PATH/pull-via-mirror.sh"'),
    "action.yml must call pull-via-mirror.sh",
  );
  const barePulls = action
    .split("\n")
    .filter((line) => /^\s*docker pull\b/.test(line));
  assert.deepEqual(
    barePulls,
    [],
    "action.yml must not pull images inline — route them through pull-via-mirror.sh",
  );
});

// Ordering guard: every job that uses docker-mirror must log in to Docker Hub
// before the action (so its docker.io fallback is authenticated), or be
// listed here as anonymous on purpose. The parsing and rules live in
// docker-mirror-guard.mjs; this file only runs them against the real tree
// and against fixtures.
const ANONYMOUS_BY_DESIGN = new Set(["screenshots.yml:capture"]);

function workflowFiles() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => ({
      file,
      text: readFileSync(join(WORKFLOWS_DIR, file), "utf8"),
    }));
}

test("every docker-mirror job logs in to Docker Hub before the action, or is anonymous by design", () => {
  const jobs = workflowFiles().flatMap(({ file, text }) =>
    parseMirrorJobs(file, text),
  );
  assert.ok(
    jobs.length > 1,
    "expected several workflow jobs that use docker-mirror",
  );
  assert.deepEqual(mirrorLoginProblems(jobs, ANONYMOUS_BY_DESIGN), []);
});

test("the parser accounts for every docker-mirror reference in every workflow", () => {
  const mismatches = workflowFiles()
    .map(({ file, text }) =>
      mirrorReferenceMismatch(file, text, parseMirrorJobs(file, text)),
    )
    .filter(Boolean);
  assert.deepEqual(mismatches, []);
});

const wf = (body) => `name: x\non: workflow_dispatch\njobs:\n${body}`;
const MIRROR = "      - uses: ./.github/actions/docker-mirror\n";
const LOGIN = "      - uses: docker/login-action@v4\n";

/** Problems for one fixture, plus the raw-text cross-check if it fires. */
function check(text, anonymous = new Set()) {
  const jobs = parseMirrorJobs("c.yml", text);
  const mismatch = mirrorReferenceMismatch("c.yml", text, jobs);
  return [
    ...mirrorLoginProblems(jobs, anonymous),
    ...(mismatch ? [mismatch] : []),
  ];
}

function assertOneProblem(label, text, pattern) {
  const problems = check(text);
  assert.equal(
    problems.length,
    1,
    `${label}: expected one problem, got ${JSON.stringify(problems)}`,
  );
  assert.match(problems[0], pattern, label);
}

const AFTER =
  /^c\.yml:b logs in to Docker Hub \(step \d+\) after docker-mirror/;
const NO_LOGIN =
  /^c\.yml:b uses docker-mirror \(step \d+\) but has no unconditional docker\/login-action step for Docker Hub/;

test("the login-order guard reads shapes a line-based parser skipped", () => {
  const cases = {
    "column-0 comment inside jobs:": [
      wf(
        "  a:\n    runs-on: x\n    steps:\n      - run: true\n# --- e2e jobs ---\n  b:\n    runs-on: x\n    steps:\n" +
          MIRROR,
      ),
      NO_LOGIN,
    ],
    "4-space job indent": [
      wf(
        "    b:\n        runs-on: x\n        steps:\n            - uses: ./.github/actions/docker-mirror\n",
      ),
      NO_LOGIN,
    ],
    "quoted job key": [
      wf('  "b":\n    runs-on: x\n    steps:\n' + MIRROR),
      NO_LOGIN,
    ],
    "quoted uses path": [
      wf(
        '  b:\n    runs-on: x\n    steps:\n      - uses: "./.github/actions/docker-mirror"\n' +
          LOGIN,
      ),
      AFTER,
    ],
    "flow-style step": [
      wf(
        "  b:\n    runs-on: x\n    steps:\n      - {uses: ./.github/actions/docker-mirror}\n" +
          LOGIN,
      ),
      AFTER,
    ],
    "login after the mirror": [
      wf("  b:\n    runs-on: x\n    steps:\n" + MIRROR + LOGIN),
      AFTER,
    ],
    "comments on job, steps: and mirror step": [
      wf(
        "  b: # required check\n    runs-on: x\n    steps: # all of them\n      - uses: ./.github/actions/docker-mirror # pre-pull\n" +
          LOGIN,
      ),
      AFTER,
    ],
  };
  for (const [label, [text, pattern]] of Object.entries(cases))
    assertOneProblem(label, text, pattern);
});

test("only an unconditional docker/login-action to Docker Hub counts as a login", () => {
  const cases = {
    // CLI logins are not recognised at all — see docker-mirror-guard.mjs.
    "GHCR login via docker login CLI": wf(
      '  b:\n    runs-on: x\n    steps:\n      - run: echo "$T" | docker login "$REGISTRY" -u "$ACTOR" --password-stdin\n' +
        MIRROR,
    ),
    "Docker Hub login via docker login CLI": wf(
      '  b:\n    runs-on: x\n    steps:\n      - run: echo "$T" | docker login -u me --password-stdin\n' +
        MIRROR,
    ),
    "echo mentioning docker login": wf(
      '  b:\n    runs-on: x\n    steps:\n      - run: echo "skipping docker login"\n' +
        MIRROR,
    ),
    "login-action with if: false": wf(
      "  b:\n    runs-on: x\n    steps:\n      - if: false\n        uses: docker/login-action@v4\n" +
        MIRROR,
    ),
    "login-action with a runtime if:": wf(
      "  b:\n    runs-on: x\n    steps:\n      - name: Log in\n        if: github.event_name == 'push'\n        uses: docker/login-action@v4\n" +
        MIRROR,
    ),
    "login-action to GHCR": wf(
      "  b:\n    runs-on: x\n    steps:\n      - uses: docker/login-action@v4\n        with:\n          registry: ghcr.io\n" +
        MIRROR,
    ),
    "login-action to an expression registry": wf(
      "  b:\n    runs-on: x\n    steps:\n      - uses: docker/login-action@v4\n        with:\n          registry: ${{ env.REG }}\n" +
        MIRROR,
    ),
    "no login at all": wf("  b:\n    runs-on: x\n    steps:\n" + MIRROR),
  };
  for (const [label, text] of Object.entries(cases))
    assertOneProblem(label, text, NO_LOGIN);
});

test("a correct login order passes", () => {
  const cases = {
    "named login-action": wf(
      "  b: # fine\n    runs-on: x\n    steps:\n      - name: Log in to Docker Hub\n        uses: docker/login-action@v4\n        with:\n          username: u\n          password: p\n      - uses: ./.github/actions/docker-mirror # pre-pull\n",
    ),
    "explicit Docker Hub registry": wf(
      "  b:\n    runs-on: x\n    steps:\n      - uses: docker/login-action@v4\n        with:\n          registry: index.docker.io\n" +
        MIRROR,
    ),
    "GHCR login after, Docker Hub login before": wf(
      "  b:\n    runs-on: x\n    steps:\n" +
        LOGIN +
        MIRROR +
        "      - if: always()\n        uses: docker/login-action@v4\n        with:\n          registry: ghcr.io\n",
    ),
    "4-space indent, quoted key and path, flow-style login": wf(
      '    "b":\n        steps:\n            - {uses: docker/login-action@v4}\n            - uses: "./.github/actions/docker-mirror"\n',
    ),
    "mirror path named only in a comment": wf(
      "  b:\n    runs-on: x\n    steps:\n      # see .github/actions/docker-mirror\n      - run: true\n",
    ),
  };
  for (const [label, text] of Object.entries(cases))
    assert.deepEqual(check(text), [], label);
});

test("anonymous-by-design entries are honoured and must not go stale", () => {
  const anonymous = wf("  b:\n    runs-on: x\n    steps:\n" + MIRROR);
  assert.deepEqual(check(anonymous, new Set(["c.yml:b"])), []);
  assert.deepEqual(
    check(wf("  b:\n    steps:\n" + LOGIN + MIRROR), new Set(["c.yml:b"])),
    ["c.yml:b is listed as anonymous but logs in to Docker Hub"],
  );
  assert.deepEqual(mirrorLoginProblems([], new Set(["gone.yml:job"])), [
    "ANONYMOUS_BY_DESIGN lists gone.yml:job, which no longer uses docker-mirror",
  ]);
});

test("a mirror reference the parser cannot account for fails the check", () => {
  // A run: script that names the action, a value that names it, a `#` inside
  // a quoted string (which a line-based "skip after #" count read as a
  // comment), and a local path outside the repo's actions: none is a mirror
  // step, so the cross-check must say so rather than pass.
  for (const step of [
    "      - run: cat ./.github/actions/docker-mirror/action.yml\n",
    "      - run: true\n        env:\n          ACTION: ./.github/actions/docker-mirror\n",
    "      - run: \"echo '# see ./.github/actions/docker-mirror'\"\n",
    "      - uses: ../elsewhere/.github/actions/docker-mirror\n",
  ]) {
    const problems = check(wf("  b:\n    steps:\n" + LOGIN + step));
    assert.equal(problems.length, 1, `${step}: ${JSON.stringify(problems)}`);
    assert.match(
      problems[0],
      /^c\.yml mentions docker-mirror 1 time\(s\) outside comments, but 0 step\(s\) use/,
      step,
    );
  }
});

test("other spellings of the mirror path are recognised as mirror steps and checked", () => {
  const cases = {
    // `#` inside a quoted flow-style name used to swallow the reference on
    // both sides, so the job silently dropped out of the check.
    "flow-style step, # in a quoted name, trailing-slash uses": wf(
      '  b:\n    runs-on: x\n    steps:\n      - { name: "Mirror #1", uses: ./.github/actions/docker-mirror/ }\n',
    ),
    "path through ..": wf(
      "  b:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/../actions/docker-mirror\n",
    ),
  };
  for (const [label, text] of Object.entries(cases))
    assertOneProblem(label, text, NO_LOGIN);
});

// Anchors defined in job a and reused through aliases in job b. The parser
// resolves the aliases, so job b has real mirror and login steps; the
// reference count must see the alias too, or the two sides disagree.
const ANCHORED = (second) =>
  wf(
    "  a:\n    runs-on: x\n    steps:\n      - &login\n        uses: docker/login-action@v4\n      - &mirror\n        uses: ./.github/actions/docker-mirror\n  b:\n    runs-on: x\n    steps:\n" +
      second,
  );

test("steps reused through YAML aliases are counted and checked", () => {
  assert.deepEqual(
    check(ANCHORED("      - *login\n      - *mirror\n")),
    [],
    "aliased login before aliased mirror",
  );
  assert.deepEqual(
    check(
      wf(
        "  a:\n    steps:\n" +
          LOGIN +
          "      - uses: &m ./.github/actions/docker-mirror\n  b:\n    steps:\n" +
          LOGIN +
          "      - uses: *m\n",
      ),
    ),
    [],
    "aliased uses scalar",
  );
  assertOneProblem(
    "aliased mirror before aliased login",
    ANCHORED("      - *mirror\n      - *login\n"),
    AFTER,
  );
});

test("no composite action other than docker-mirror wraps docker-mirror", () => {
  const actions = readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ["action.yml", "action.yaml"]
        .map((file) => join(ACTIONS_DIR, entry.name, file))
        .filter((path) => existsSync(path))
        .map((path) => ({
          file: path.slice(ROOT.length + 1),
          text: readFileSync(path, "utf8"),
        })),
    );
  assert.ok(actions.length > 1, "expected several composite actions");
  assert.deepEqual(compositeMirrorProblems(actions), []);
});

test("a composite action that references docker-mirror fails the check", () => {
  const wrapper = {
    file: ".github/actions/pull-all/action.yml",
    text: "name: x\n# docker-mirror is mentioned in a comment, which is fine\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/docker-mirror\n",
  };
  const itself = {
    file: ".github/actions/docker-mirror/action.yml",
    text: "name: docker-mirror\nruns:\n  using: composite\n  steps: []\n",
  };
  const commentOnly = {
    file: ".github/actions/other/action.yml",
    text: "name: x # unlike docker-mirror\nruns:\n  using: composite\n  steps: []\n",
  };
  const problems = compositeMirrorProblems([wrapper, itself, commentOnly]);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(
    problems[0],
    /^\.github\/actions\/pull-all\/action\.yml references docker-mirror 1 time\(s\).*extend docker-mirror-guard\.mjs/,
  );
});

test("a workflow that does not parse fails with the file name", () => {
  assert.throws(
    () => parseMirrorJobs("broken.yml", "jobs:\n  a:\n    steps: [\n"),
    /^Error: broken\.yml: YAML does not parse/,
  );
});
