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

// Behavior tests + wiring guards for the GHCR pull-retry hardening (CI run
// 27339671342: two jobs died on a transient ghcr.io outage before any test
// ran). The retry logic lives in a standalone script inside the composite
// action so it can be exercised here against a stub `docker` binary — same
// transient-5xx hardening family as the ollama-install retry from PR #471.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTION_DIR = join(ROOT, ".github", "actions", "pull-ci-images");
const SCRIPT = join(ACTION_DIR, "pull-images-with-retry.sh");
const ACTION_YML = join(ACTION_DIR, "action.yml");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const CI_YML = join(WORKFLOWS_DIR, "ci.yml");

const GHCR_OUTAGE_ERROR =
  'Error response from daemon: Get "https://ghcr.io/v2/": context deadline exceeded (Client.Timeout exceeded while awaiting headers)';

/**
 * Creates a stub `docker` on PATH that fails the first `failTimes` pulls of
 * each image (with a GHCR-outage-shaped error unless `errorMessage` overrides
 * it), then succeeds. Pull counts are recorded per image so tests can assert
 * the retry cadence.
 */
function runScriptWithStub({ failTimes, images, errorMessage }) {
  const stubDir = mkdtempSync(join(tmpdir(), "pull-ci-images-stub-"));
  const stub = join(stubDir, "docker");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
[ "$1" = "pull" ] || { echo "stub docker: unexpected subcommand $1" >&2; exit 64; }
image_key=$(printf '%s' "$2" | tr -c 'a-zA-Z0-9' '_')
count_file="$STUB_DIR/count-$image_key"
count=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
printf '%s' "$count" > "$count_file"
if [ "$count" -le "$FAIL_TIMES" ]; then
  echo "$STUB_ERROR_MESSAGE" >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(stub, 0o755);

  const result = spawnSync("bash", [SCRIPT, ...images], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      STUB_DIR: stubDir,
      FAIL_TIMES: String(failTimes),
      STUB_ERROR_MESSAGE: errorMessage ?? GHCR_OUTAGE_ERROR,
      // Tests must not sit through the real backoff.
      PULL_RETRY_DELAY_SECONDS: "0",
    },
  });

  const pullCount = (image) => {
    const key = image.replace(/[^a-zA-Z0-9]/g, "_");
    const file = join(stubDir, `count-${key}`);
    return existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  };

  return { result, pullCount };
}

const PINCHY = "ghcr.io/heypinchy/pinchy:ci-abc123";
const OPENCLAW = "ghcr.io/heypinchy/pinchy-openclaw:ci-abc123";

test("pulls every image once and exits 0 when the registry is healthy", () => {
  const { result, pullCount } = runScriptWithStub({
    failTimes: 0,
    images: [PINCHY, OPENCLAW],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(pullCount(PINCHY), 1);
  assert.equal(pullCount(OPENCLAW), 1);
});

test("retries transient failures and succeeds within 3 attempts", () => {
  const { result, pullCount } = runScriptWithStub({
    failTimes: 2,
    images: [PINCHY, OPENCLAW],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(pullCount(PINCHY), 3);
  assert.equal(pullCount(OPENCLAW), 3);
  assert.ok(
    result.stdout.includes("::warning::"),
    "retries must surface as ::warning:: annotations so transient blips stay visible",
  );
  assert.ok(
    result.stdout.includes("attempt 1/3"),
    "the warning must say which attempt failed",
  );
});

test("fails with a ::error:: annotation after 3 exhausted attempts", () => {
  const { result, pullCount } = runScriptWithStub({
    failTimes: 99,
    images: [PINCHY, OPENCLAW],
  });
  assert.equal(result.status, 1);
  assert.equal(
    pullCount(PINCHY),
    3,
    "must stop after 3 attempts, not loop forever",
  );
  assert.ok(
    result.stdout.includes("::error::"),
    "exhaustion must emit a ::error:: annotation",
  );
  assert.ok(
    result.stdout.includes(PINCHY),
    "the error must name the image that could not be pulled",
  );
});

test("rejects a call without image refs instead of silently succeeding", () => {
  const { result } = runScriptWithStub({ failTimes: 0, images: [] });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("::error::"));
});

// Composite actions do NOT enforce `required: true` on inputs: a dropped
// `with:` field or a renamed build-image output arrives as an empty string.
// That must fail fast with a wiring hint, not burn 40s retrying `docker
// pull ""`.
test("fails fast on an empty image ref instead of retrying docker pull ''", () => {
  const { result, pullCount } = runScriptWithStub({
    failTimes: 0,
    images: [PINCHY, ""],
  });
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("::error::"));
  assert.ok(
    result.stdout.includes("empty image ref"),
    "the error must point at the with:/outputs wiring, not at GHCR",
  );
  assert.equal(
    pullCount(PINCHY),
    0,
    "all refs must be validated before any pull starts",
  );
});

test("does not retry deterministic failures like a missing manifest", () => {
  const { result, pullCount } = runScriptWithStub({
    failTimes: 99,
    images: [PINCHY, OPENCLAW],
    errorMessage: "Error response from daemon: manifest unknown",
  });
  assert.equal(result.status, 1);
  assert.equal(
    pullCount(PINCHY),
    1,
    "a manifest-unknown failure is deterministic — retrying wastes 40s",
  );
  assert.equal(pullCount(OPENCLAW), 0);
  assert.ok(result.stdout.includes("::error::"));
  assert.ok(result.stdout.includes("non-transient"));
});

// Wiring guards: the script only protects CI if the composite action invokes
// it and ci.yml actually routes pulls through the action. Same textual-sweep
// approach as release-version-guards.test.mjs.

test("the composite action invokes the retry script", () => {
  const action = readFileSync(ACTION_YML, "utf8");
  assert.ok(
    action.includes("pull-images-with-retry.sh"),
    "action.yml must call pull-images-with-retry.sh — inline pulls would dodge the tested retry logic",
  );
});

test("no workflow has bare docker pulls of the pre-built CI images", () => {
  const workflows = readdirSync(WORKFLOWS_DIR).filter(
    (file) => file.endsWith(".yml") || file.endsWith(".yaml"),
  );
  assert.ok(workflows.length > 0, "no workflow files found — wrong path?");
  for (const file of workflows) {
    const bare = readFileSync(join(WORKFLOWS_DIR, file), "utf8")
      .split("\n")
      .filter((line) => line.includes("docker pull ${{ needs.build-image"));
    assert.deepEqual(
      bare,
      [],
      `${file}: pull pre-built images via ./.github/actions/pull-ci-images ` +
        "(retries transient GHCR outages); bare docker pull fails the job " +
        "on the first network blip",
    );
  }
  assert.ok(
    readFileSync(CI_YML, "utf8").includes(
      "uses: ./.github/actions/pull-ci-images",
    ),
    "ci.yml must pull the pre-built images through the pull-ci-images composite action",
  );
});
