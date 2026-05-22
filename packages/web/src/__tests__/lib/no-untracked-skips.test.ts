// Enforcement guard: every static skip / todo / xit in a test file must be
// linked to a tracking issue (`#NNN`) in the comment block immediately above
// it. Conditional skips (`.skipIf(...)`) are exempt because they're driven by
// runtime conditions (env vars, OS features) rather than "we'll come back to
// this later — promise" rationalisations.
//
// Why this guard exists: the 2026-05-22 audit found five separate skip
// clusters that all followed the same pattern — quick fix at the time, honest
// comment saying "tracked separately", and then no issue ever filed. The
// outcome was a production-breaking password-reset bug that sat behind four
// silent `.skip()`s for weeks. See `feedback_no_unilateral_skips.md` in the
// user's memory and AGENTS.md § "No untracked test skips" for the policy.
//
// Companion to the ESLint rule at
// `packages/web/eslint-rules/no-untracked-skips.js`. When you add a new skip
// syntax to one checker, add it to the other — the parity test at
// `no-untracked-skips-parity.test.ts` will fail if they drift apart.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../../..");

// Roots we scan. We deliberately stay inside our own monorepo packages and
// don't descend into `node_modules`, build output, or `docs/` (which has its
// own test setup and isn't shipped as part of the app).
const SCAN_ROOTS = ["packages"];

const TEST_FILE_RE = /\.(test|spec)\.(?:c|m)?[jt]sx?$/;

// Permanent-skip patterns we forbid without an issue link. We do NOT match
// `.skipIf(` here — that's an explicit conditional gate, not a "we'll fix
// this later" suppression.
const SKIP_RE = /\b(?:test|it|describe)\.(?:skip|todo|fixme)\s*\(/;
const X_RE = /^\s*(?:xit|xdescribe)\s*\(/;
// Token a passing skip-comment must contain. Either a bare issue number (#42),
// a fully-qualified GitHub URL, or any of these escape hatches that have a
// dedicated, separately-tracked policy doc.
const ISSUE_REF_RE = /#\d+|github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

function walkTestFiles(dir: string): string[] {
  const result: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "build") {
      continue;
    }
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      result.push(...walkTestFiles(fullPath));
    } else if (TEST_FILE_RE.test(entry)) {
      result.push(fullPath);
    }
  }
  return result;
}

/**
 * The skip's tracking-issue comment can sit:
 *   - directly above the `.skip(...)` call,
 *   - or one block up (above the surrounding `test.describe(...)`),
 *   - sometimes interleaved with block-open scaffolding.
 *
 * Walking the AST would be the principled fix; pragmatically, scanning the
 * 40 lines immediately above the skip for an issue reference gets us the
 * coverage we need with a fraction of the code. A false negative would
 * require an unrelated `#NNN` to coincidentally sit within 40 lines of an
 * untracked skip — small, and a code review will catch it.
 *
 * We deliberately scan code AND comments. A test's leading scaffolding can
 * include argument tuples (`({ page })`) and arrow-function headers, and we
 * don't want regex-fragility there to swallow an otherwise-valid comment.
 */
function leadingContext(lines: string[], lineIdx: number): string {
  const start = Math.max(0, lineIdx - 40);
  return lines.slice(start, lineIdx).join("\n");
}

interface Finding {
  file: string;
  line: number;
  match: string;
}

function findUntrackedSkips(file: string): Finding[] {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Strip line-comments so we don't match `.skip(` references in
    // documentation about the rule itself.
    const codeOnly = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (!SKIP_RE.test(codeOnly) && !X_RE.test(codeOnly)) continue;

    // `.skipIf(` is a conditional gate, not a permanent skip — allow.
    if (/\b(?:test|it|describe)\.skipIf\s*\(/.test(codeOnly)) continue;

    const context = leadingContext(lines, i);
    if (ISSUE_REF_RE.test(context)) continue;

    findings.push({
      file,
      line: i + 1,
      match: codeOnly.trim().slice(0, 100),
    });
  }
  return findings;
}

describe("no-untracked-skips", () => {
  it("every static .skip/.todo/.fixme/xit/xdescribe is linked to a tracking issue", () => {
    const testFiles: string[] = [];
    for (const root of SCAN_ROOTS) {
      testFiles.push(...walkTestFiles(resolve(REPO_ROOT, root)));
    }
    // Don't let this guard catch itself, the parity test's fixture
    // literals, or the eslint rule's own fixture file.
    const filtered = testFiles.filter((f) => {
      const rel = relative(REPO_ROOT, f);
      return (
        rel !== "packages/web/src/__tests__/lib/no-untracked-skips.test.ts" &&
        rel !== "packages/web/src/__tests__/lib/no-untracked-skips-parity.test.ts" &&
        !rel.startsWith("packages/web/eslint-rules/") &&
        !rel.includes("/__tests__/eslint/")
      );
    });

    const findings: Finding[] = [];
    for (const file of filtered) {
      findings.push(...findUntrackedSkips(file));
    }

    const message = findings.length
      ? [
          "The following permanent skips have no tracking issue (#NNN) in their",
          "leading comment. Either add an issue link or remove the skip:",
          "",
          ...findings.map((f) => `  ${relative(REPO_ROOT, f.file)}:${f.line}  →  ${f.match}`),
          "",
          'Conditional gates (`.skipIf(...)`) are exempt. See AGENTS.md § "No untracked test skips".',
        ].join("\n")
      : "";

    expect(findings, message).toEqual([]);
  });
});
