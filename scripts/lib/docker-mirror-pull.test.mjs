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

// Ordering guard: a docker.io fallback inside the action can only use the
// authenticated pull limit if the job has already logged in to Docker Hub.
// Credentials live in the client's ~/.docker/config.json, so the action's
// daemon restart does not discard them. Jobs that never log in stay
// anonymous — the action text says so.
// Jobs that use docker-mirror without any Docker Hub login, on purpose. Every
// other docker-mirror job must have a recognised Docker Hub login BEFORE the
// action. A job the parser cannot read therefore fails loudly instead of
// silently dropping out of the check.
const ANONYMOUS_BY_DESIGN = new Set(["screenshots.yml:capture"]);

const COMMENT_TAIL = String.raw`\s*(?:#.*)?$`;
const JOB_HEADER = new RegExp(
  String.raw`^ {2}([A-Za-z0-9_-]+):` + COMMENT_TAIL,
);
const STEPS_KEY = new RegExp(String.raw`^(\s*)steps:` + COMMENT_TAIL);
const MIRROR_USE = new RegExp(
  String.raw`uses:\s*\.\/\.github\/actions\/docker-mirror` + COMMENT_TAIL,
);
const DOCKER_HUB_REGISTRY =
  /^(docker\.io|index\.docker\.io|registry-1\.docker\.io)$/i;

/**
 * Every job in one workflow file that uses the docker-mirror action, with the
 * line of the action and of the first Docker Hub login (-1 if none).
 * A Docker Hub login is recognised by what it does: a `docker/login-action`
 * step whose `registry:` is absent or a Docker Hub host, or a `run:` step that
 * calls `docker login` without naming another registry.
 */
export function parseMirrorJobs(file, text) {
  const lines = text.split("\n");
  const jobsStart = lines.findIndex((line) =>
    new RegExp("^jobs:" + COMMENT_TAIL).test(line),
  );
  if (jobsStart === -1) return [];
  const jobs = [];
  let job = null;
  let step = null;
  const closeStep = () => {
    if (job && step && job.login === -1) {
      const viaAction =
        step.loginAction &&
        (step.registry === null || DOCKER_HUB_REGISTRY.test(step.registry));
      if (viaAction || step.cliLogin) job.login = step.line;
    }
    step = null;
  };
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== "") break; // next top-level key
    const header = line.match(JOB_HEADER);
    if (header) {
      closeStep();
      job = { file, name: header[1], mirror: -1, login: -1 };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    const stepsKey = line.match(STEPS_KEY);
    if (stepsKey) {
      closeStep();
      job.stepIndent = null;
      job.stepsKeyIndent = stepsKey[1].length;
      continue;
    }
    const item = line.match(/^(\s*)-\s/);
    if (item && job.stepsKeyIndent !== undefined) {
      // The first list item under `steps:` fixes the step indent; only items
      // at exactly that indent start a new step (not lines inside run: blocks).
      if (job.stepIndent == null && item[1].length >= job.stepsKeyIndent) {
        job.stepIndent = item[1].length;
      }
      if (item[1].length === job.stepIndent) {
        closeStep();
        step = {
          line: i + 1,
          loginAction: false,
          registry: null,
          cliLogin: false,
        };
      }
    }
    if (step && /uses:\s*docker\/login-action@/.test(line))
      step.loginAction = true;
    const registry = line.match(/^\s*registry:\s*['"]?([^'"\s#]+)/);
    if (step && registry) step.registry = registry[1];
    if (step) {
      const cli = line.match(/\bdocker\s+login\b(.*)$/);
      if (cli) {
        const host = cli[1]
          .split(/\s+/)
          .find(
            (arg) =>
              arg &&
              !arg.startsWith("-") &&
              !arg.startsWith("$") &&
              !arg.startsWith('"'),
          );
        if (!host || DOCKER_HUB_REGISTRY.test(host)) step.cliLogin = true;
      }
    }
    if (job.mirror === -1 && MIRROR_USE.test(line)) job.mirror = i + 1;
  }
  closeStep();
  return jobs.filter((j) => j.mirror !== -1);
}

/** Problems with the login order, and stale ANONYMOUS_BY_DESIGN entries. */
export function mirrorLoginProblems(jobs, anonymousByDesign) {
  const problems = [];
  for (const job of jobs) {
    const key = `${job.file}:${job.name}`;
    if (anonymousByDesign.has(key)) {
      if (job.login !== -1)
        problems.push(
          `${key} is listed as anonymous but logs in to Docker Hub`,
        );
      continue;
    }
    if (job.login === -1) {
      problems.push(
        `${key} uses docker-mirror (line ${job.mirror}) but no Docker Hub login was recognised before it — add one before the action, or list the job in ANONYMOUS_BY_DESIGN`,
      );
    } else if (job.login > job.mirror) {
      problems.push(
        `${key} logs in to Docker Hub (line ${job.login}) after docker-mirror (line ${job.mirror})`,
      );
    }
  }
  const seen = new Set(jobs.map((job) => `${job.file}:${job.name}`));
  for (const key of anonymousByDesign) {
    if (!seen.has(key))
      problems.push(
        `ANONYMOUS_BY_DESIGN lists ${key}, which no longer uses docker-mirror`,
      );
  }
  return problems;
}

function dockerMirrorJobs() {
  const jobs = [];
  for (const file of readdirSync(WORKFLOWS_DIR)) {
    if (!/\.ya?ml$/.test(file)) continue;
    jobs.push(
      ...parseMirrorJobs(file, readFileSync(join(WORKFLOWS_DIR, file), "utf8")),
    );
  }
  return jobs;
}

test("every docker-mirror job logs in to Docker Hub before the action, or is anonymous by design", () => {
  const jobs = dockerMirrorJobs();
  assert.ok(
    jobs.length > 1,
    "expected several workflow jobs that use docker-mirror",
  );
  assert.deepEqual(mirrorLoginProblems(jobs, ANONYMOUS_BY_DESIGN), []);
});

test("the login-order guard reports misordered and unreadable shapes instead of skipping them", () => {
  const wf = (body) => `name: x\non: workflow_dispatch\njobs:\n${body}`;
  const cases = {
    "comment on job header": wf(
      "  first:\n    runs-on: x\n    steps:\n      - uses: docker/login-action@v4\n      - uses: ./.github/actions/docker-mirror\n  second: # required check\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/docker-mirror\n      - uses: docker/login-action@v4\n",
    ),
    "comment on steps:": wf(
      "  only:\n    runs-on: x\n    steps: # all of them\n      - uses: ./.github/actions/docker-mirror\n      - uses: docker/login-action@v4\n",
    ),
    "comment on the mirror step": wf(
      "  only:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/docker-mirror # pre-pull\n      - uses: docker/login-action@v4\n",
    ),
    "index.docker.io registry": wf(
      "  only:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/docker-mirror\n      - uses: docker/login-action@v4\n        with:\n          registry: index.docker.io\n",
    ),
    "docker login via run": wf(
      '  only:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/docker-mirror\n      - run: echo "$T" | docker login -u me --password-stdin\n',
    ),
    "renamed login": wf(
      "  only:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/docker-mirror\n      - name: Login to Docker Hub\n        uses: docker/login-action@v4\n",
    ),
    "no login at all": wf(
      "  only:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/docker-mirror\n",
    ),
  };
  for (const [label, text] of Object.entries(cases)) {
    const problems = mirrorLoginProblems(
      parseMirrorJobs("canary.yml", text),
      new Set(),
    );
    assert.ok(problems.length > 0, `guard missed: ${label}`);
  }
  // A GHCR-only login after the action is not a Docker Hub login, so a job
  // with only that must still be reported (as having no Docker Hub login).
  const ghcrOnly = wf(
    "  only:\n    runs-on: x\n    steps:\n      - uses: docker/login-action@v4\n        with:\n          registry: ghcr.io\n      - uses: ./.github/actions/docker-mirror\n",
  );
  assert.equal(
    mirrorLoginProblems(parseMirrorJobs("c.yml", ghcrOnly), new Set()).length,
    1,
  );
  // The correct order passes.
  const good = wf(
    "  only: # fine\n    runs-on: x\n    steps:\n      - name: Log in\n        uses: docker/login-action@v4\n      - uses: ./.github/actions/docker-mirror # pre-pull\n",
  );
  assert.deepEqual(
    mirrorLoginProblems(parseMirrorJobs("c.yml", good), new Set()),
    [],
  );
  // A stale anonymous entry is reported.
  assert.equal(mirrorLoginProblems([], new Set(["gone.yml:job"])).length, 1);
});
