import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the failed v0.5.0 docs deploy: screenshots/seed.sh's
// `api()` wrapper called `/api/auth/sign-in/email` without an Origin
// header, after PR #235 (`81cf52e31 feat(security): Origin/Referer CSRF
// gate for state-changing API routes`) made every state-changing /api/*
// route reject requests without Origin or Referer.
//
// The CSRF gate was already retro-fitted to e2e helpers in commits
// `4df0e0d9d` and `74444f275`, but screenshots/seed.sh was missed and
// silently broke the docs-deploy step of the v0.5.0 Release workflow.
//
// Invariant enforced: any shell script tracked in this repo that runs
// `curl -X POST/PATCH/PUT/DELETE` against a /api/... path must include the
// substring "Origin" somewhere in its body. The substring may appear in
// the curl invocation directly, in a wrapper function (e.g. seed.sh's
// `api()` helper that injects `-H "Origin: …"` for every call), or in a
// comment explaining why the script is exempt.
//
// Limiting the check to shell scripts keeps the test deterministic — TS/JS
// callers go through fetch(), which is already covered by the
// auth-config-consistency suite and individual e2e helper tests.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listTrackedShellScripts() {
  const out = execSync("git ls-files -z '*.sh' '*.bash'", {
    cwd: ROOT,
    encoding: "buffer",
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((rel) => join(ROOT, rel));
}

// Matches a state-changing call: either `curl -X METHOD …` directly, or a
// wrapper invocation of the form `<word> -X METHOD …`. Scripts in this
// repo (e.g. screenshots/seed.sh) commonly define an `api()` helper that
// forwards args to curl, so a wrapper-only check must work too.
const STATE_CHANGING_CALL = /^\s*\S+[^#\n]*\B-X\s+(POST|PATCH|PUT|DELETE)\b/;
const CURL_PRESENT = /\bcurl\b/;
const API_PATH = /\/api\//;

test("shell scripts that curl state-changing /api/ endpoints set Origin (CSRF gate)", () => {
  const offenders = [];
  for (const path of listTrackedShellScripts()) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (!CURL_PRESENT.test(text)) continue;
    const lines = text.split("\n");

    let invokesStateChangingApi = false;
    for (const line of lines) {
      // Skip commented-out lines so a deliberately disabled curl doesn't
      // require Origin coverage. Match leading-`#` only — inline comments
      // don't disable the curl itself.
      if (/^\s*#/.test(line)) continue;
      if (STATE_CHANGING_CALL.test(line) && API_PATH.test(line)) {
        invokesStateChangingApi = true;
        break;
      }
    }

    if (!invokesStateChangingApi) continue;
    if (/\bOrigin\b/.test(text)) continue;

    offenders.push(path.replace(`${ROOT}/`, ""));
  }

  assert.equal(
    offenders.length,
    0,
    `Shell script(s) curl state-changing /api/* without setting Origin ` +
      `(CSRF gate from PR #235 will reject them). Add ` +
      `\`-H "Origin: $BASE_URL"\` to the curl call or to a shared wrapper:\n` +
      `  - ${offenders.join("\n  - ")}`,
  );
});

// Sanity guard against a future refactor that moves the seed script away
// without the test maintainer noticing — if the discovery sweep finds zero
// shell scripts, the main assertion above passes vacuously.
test("git ls-files actually finds shell scripts in the repo", () => {
  const scripts = listTrackedShellScripts();
  assert.ok(
    scripts.length >= 3,
    `expected ≥3 tracked .sh files, got ${scripts.length}`,
  );
});
