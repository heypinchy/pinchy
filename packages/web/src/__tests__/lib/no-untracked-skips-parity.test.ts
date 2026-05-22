// Parity guard: the ESLint rule `pinchy/no-untracked-skips` and the vitest
// drift-guard `no-untracked-skips.test.ts` are intentionally two separate
// checkers (defence in depth: lint catches at edit time, drift-guard catches
// at CI time and survives an `eslint-disable`). For that defence to be real,
// they must agree on what counts as a tracked vs untracked skip. This file
// feeds the same fixtures through both and asserts identical verdicts.
//
// If you add a new skip syntax to one checker (e.g. `suite.skip` in Vitest
// 4) and not the other, the relevant fixture below will fail with a
// mismatched verdict — that's the failure mode this guard is here to catch.

import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-untracked-skips.js");

// Keep these regex constants in lockstep with packages/web/src/__tests__/lib/no-untracked-skips.test.ts.
// (Drift-guard's regex is the canonical text-scan; this copy is what we
// use to simulate the drift-guard's behaviour over a single snippet.)
const SKIP_RE = /\b(?:test|it|describe)\.(?:skip|todo|fixme)\s*\(/;
const X_RE = /^\s*(?:xit|xdescribe)\s*\(/;
const ISSUE_REF_RE = /#\d+|github\.com\/[^/]+\/[^/]+\/issues\/\d+/;

function eslintFlags(code: string): boolean {
  const linter = new Linter();
  const messages = linter.verify(code, {
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    plugins: { local: { rules: { "no-untracked-skips": rule } } },
    rules: { "local/no-untracked-skips": "error" },
  });
  return messages.length > 0;
}

function driftGuardFlags(code: string): boolean {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const codeOnly = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (!SKIP_RE.test(codeOnly) && !X_RE.test(codeOnly)) continue;
    if (/\b(?:test|it|describe)\.skipIf\s*\(/.test(codeOnly)) continue;
    const start = Math.max(0, i - 40);
    const leading = lines.slice(start, i).join("\n");
    if (ISSUE_REF_RE.test(leading)) continue;
    return true;
  }
  return false;
}

const FIXTURES: Array<{ name: string; code: string; shouldFlag: boolean }> = [
  // ── Untracked skips that BOTH checkers should flag ─────────────────
  { name: "bare test.skip", code: `test.skip("foo", () => {});`, shouldFlag: true },
  { name: "bare it.skip", code: `it.skip("foo", () => {});`, shouldFlag: true },
  { name: "bare describe.skip", code: `describe.skip("foo", () => {});`, shouldFlag: true },
  { name: "it.todo no issue", code: `it.todo("implement me");`, shouldFlag: true },
  { name: "describe.fixme", code: `describe.fixme("broken", () => {});`, shouldFlag: true },
  { name: "bare xit", code: `xit("foo", () => {});`, shouldFlag: true },
  { name: "bare xdescribe", code: `xdescribe("group", () => {});`, shouldFlag: true },
  {
    name: "TODO comment without issue number",
    code: `// TODO: come back to this later\ntest.skip("foo", () => {});`,
    shouldFlag: true,
  },
  // ── Tracked skips that NEITHER checker should flag ─────────────────
  {
    name: "issue ref directly above",
    code: `// tracked in #427\ntest.skip("foo", () => {});`,
    shouldFlag: false,
  },
  {
    name: "GitHub URL above",
    code: `// see https://github.com/heypinchy/pinchy/issues/123\nit.skip("bar", () => {});`,
    shouldFlag: false,
  },
  {
    name: "block comment with issue",
    code: `/** Tracked in #1234. */\ndescribe.skip("group", () => {});`,
    shouldFlag: false,
  },
  {
    name: "issue ref one block up",
    code: `// (tracked in #99)\ndescribe("group", () => {\n  test.skip("a", () => {});\n});`,
    shouldFlag: false,
  },
  // ── Conditional skipIf is always allowed ───────────────────────────
  {
    name: "describe.skipIf with env",
    code: `describe.skipIf(!process.env.RUN)("integration", () => {});`,
    shouldFlag: false,
  },
  {
    name: "test.skipIf with env",
    code: `test.skipIf(!process.env.RUN)("foo", () => {});`,
    shouldFlag: false,
  },
  // ── Non-skip calls are never flagged ───────────────────────────────
  {
    name: "ordinary test/it/describe",
    code: `test("foo", () => {});\nit("bar", () => {});\ndescribe("baz", () => {});`,
    shouldFlag: false,
  },
];

describe("no-untracked-skips parity (ESLint rule ↔ drift-guard)", () => {
  for (const { name, code, shouldFlag } of FIXTURES) {
    it(`${name}: both checkers verdict = ${shouldFlag}`, () => {
      const eslintVerdict = eslintFlags(code);
      const driftVerdict = driftGuardFlags(code);

      // First: both must match the expected verdict.
      expect(eslintVerdict, `ESLint rule should${shouldFlag ? "" : " NOT"} flag:\n${code}`).toBe(
        shouldFlag
      );
      expect(
        driftVerdict,
        `drift-guard regex should${shouldFlag ? "" : " NOT"} flag:\n${code}`
      ).toBe(shouldFlag);

      // Belt-and-suspenders: assert the two checkers agree with each
      // other (catches drift even if someone updates the fixture's
      // shouldFlag without thinking).
      expect(eslintVerdict).toBe(driftVerdict);
    });
  }
});
