import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  MIN_REASON_LENGTH,
  USER_VISIBLE_SURFACES,
  analyzeChangedPaths,
  formatFailure,
  parseDocsOverride,
} from "./docs-required.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("analyzeChangedPaths spots a new API route", () => {
  const { surfaces, docsTouched } = analyzeChangedPaths([
    "packages/web/src/app/api/automations/route.ts",
    "packages/web/src/lib/email-workflows/sweep.ts",
  ]);
  assert.equal(docsTouched, false);
  assert.deepEqual(
    surfaces.map((s) => s.path),
    ["packages/web/src/app/api/automations/route.ts"],
  );
});

test("analyzeChangedPaths is quiet when the PR also touches docs", () => {
  const analysis = analyzeChangedPaths([
    "packages/web/src/lib/tool-registry.ts",
    "docs/src/content/docs/concepts/agent-permissions.mdx",
  ]);
  assert.equal(analysis.docsTouched, true);
  assert.equal(formatFailure(analysis), "");
});

test("analyzeChangedPaths ignores ordinary source files", () => {
  // The guard must not fire on a refactor — a guard that cries wolf gets an
  // escape hatch typed into it reflexively and then guards nothing.
  const analysis = analyzeChangedPaths([
    "packages/web/src/lib/knowledge/retrieve.ts",
    "packages/web/src/components/chat/thread.tsx",
    "packages/web/src/__tests__/lib/knowledge/retrieve.test.ts",
  ]);
  assert.deepEqual(analysis.surfaces, []);
  assert.equal(formatFailure(analysis), "");
});

test("a route test file is not a route", () => {
  const analysis = analyzeChangedPaths([
    "packages/web/src/__tests__/api/agents-patch-validation.test.ts",
  ]);
  assert.deepEqual(analysis.surfaces, []);
});

test("formatFailure names the doc the reader would go to", () => {
  const message = formatFailure(
    analyzeChangedPaths(["packages/web/src/lib/audit.ts"]),
  );
  assert.match(message, /audit-trail\.mdx/);
  assert.match(message, /Docs-not-needed:/);
});

test("parseDocsOverride accepts the label", () => {
  assert.equal(parseDocsOverride({ envValue: "true" }).allowed, true);
});

test("parseDocsOverride wants a reason worth reading", () => {
  assert.equal(
    parseDocsOverride({ messages: ["Docs-not-needed: no"] }).allowed,
    false,
  );
  assert.equal(
    parseDocsOverride({
      messages: [
        "Docs-not-needed: gateway-only ingress, no reader-facing path",
      ],
    }).allowed,
    true,
  );
});

test("parseDocsOverride is not fooled by prose in an earlier commit", () => {
  // Same trap the Allow-test-deletion trailer has: `git log` concatenates every
  // message, so a mention must not shadow the real trailer in a later commit.
  const { allowed, reason } = parseDocsOverride({
    messages: [
      "docs: explain that Docs-not-needed: <reason> is the escape hatch",
      "fix(api): internal ingress\n\nDocs-not-needed: gateway-only, no reader-facing path",
    ],
  });
  assert.equal(allowed, true);
  assert.match(reason, /gateway-only/);
});

test("MIN_REASON_LENGTH rejects the reflexive non-answers", () => {
  for (const bad of ["n/a", "none", "no", "-"]) {
    assert.ok(bad.length < MIN_REASON_LENGTH, `"${bad}" should be too short`);
  }
});

test("every surface pattern still matches a real file in this repo", () => {
  // A pattern that matches nothing is a guard that has quietly stopped
  // guarding — the same stale-exemption failure the coverage guards check for.
  // A rename ("components/settings-page-content.tsx" moving) would otherwise
  // disarm one row of the table in total silence.
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  for (const surface of USER_VISIBLE_SURFACES) {
    assert.ok(
      tracked.some((p) => surface.re.test(p)),
      `no tracked file matches ${surface.re} — is the path still right?`,
    );
  }
});
