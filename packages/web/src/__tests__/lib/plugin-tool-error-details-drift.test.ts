// packages/web/src/__tests__/lib/plugin-tool-error-details-drift.test.ts
//
// #404 contract: OpenClaw strips the MCP `isError` flag before forwarding a
// tool result to /api/internal/audit/tool-use, so the audit route's only
// remaining failure signal is `result.details.error`
// (see route.ts's "3. result.details.error" comment). A plugin tool result
// that sets `isError: true` without a sibling `details.error` is silently
// audited as `outcome: success` — that's the drift this guard exists to
// catch. pinchy-odoo and pinchy-email already enforce this via a shared
// `toolError()` helper; this guard extends the same contract to every
// KNOWN_PINCHY_PLUGINS package.
//
// The scan's own fixtures live in the second describe below. They are the
// half that matters: a guard whose scanner quietly stops matching reports
// "no drift" against a healthy tree and never goes red — the same silence
// the #404 bug itself had.
import { describe, it, expect } from "vitest";
import {
  scanErrorResults,
  scanPlugin,
  KNOWN_PINCHY_PLUGINS,
  type MissingErrorDetail,
} from "./plugin-error-details-extraction";

function explain(pluginId: string, issues: MissingErrorDetail[]): string {
  return [
    `Plugin ${pluginId}: index.ts signals a tool failure the audit route cannot`,
    `see, at these locations:`,
    ...issues.map((i) => `  line ${i.line} [${i.reason}]: ${i.snippet}`),
    ``,
    `OpenClaw strips the isError flag before forwarding a tool result to`,
    `/api/internal/audit/tool-use (#404); details.error is the audit route's`,
    `only remaining failure signal, so a tool call that fails without it is`,
    `audited as outcome: success.`,
    ``,
    `missing-details-error → route this result through a toolError()-style`,
    `  helper that sets details: { error: <message> }, mirroring`,
    `  pinchy-odoo's/pinchy-email's toolError().`,
    `dynamic-is-error → isError is computed, so this scan cannot tell whether`,
    `  the failure path carries details.error. Branch on the flag and return`,
    `  toolError(...) on the error side (see pinchy_web_fetch).`,
  ].join("\n");
}

describe("plugin-tool-error-details-drift", () => {
  // Scanned inside each `it`, not once at collect time: scanPlugin throws on
  // an unreadable index.ts, and a throw during collection fails the whole
  // file — taking the scanErrorResults fixtures below with it, so a missing
  // plugin file would also silence the tests that prove the scanner works.
  for (const pluginId of KNOWN_PINCHY_PLUGINS) {
    it(`${pluginId}: every failing result carries details.error`, () => {
      const { issues } = scanPlugin(pluginId);
      expect(issues, explain(pluginId, issues)).toHaveLength(0);
    });
  }

  // A corpus floor, not a metric. Every assertion above is an absence, so a
  // walk that stops matching — a renamed AST helper, a bad PLUGINS_DIR —
  // reports a clean tree instead of a broken scan. 14 result literals were
  // present when this landed (pinchy-audit and pinchy-transcript register no
  // tools and contribute none); 10 leaves room for ordinary churn while
  // still failing loudly if the walk goes quiet.
  it("scans a real corpus of result literals", () => {
    const checked = KNOWN_PINCHY_PLUGINS.reduce((sum, id) => sum + scanPlugin(id).checked, 0);
    expect(
      checked,
      `Only ${checked} isError result literals were scanned across ${KNOWN_PINCHY_PLUGINS.length} ` +
        `plugins. That is too few to be a real corpus — the AST walk is probably matching ` +
        `nothing, which reads as "no drift" while checking nothing.`
    ).toBeGreaterThanOrEqual(10);
  });
});

describe("scanErrorResults", () => {
  const RESULT = `content: [{ type: "text", text: msg }]`;

  it("accepts a result carrying details.error", () => {
    const scan = scanErrorResults(
      `const r = { isError: true, ${RESULT}, details: { error: msg } };`
    );
    expect(scan.issues).toEqual([]);
    expect(scan.checked).toBe(1);
  });

  it("flags isError: true with no details at all", () => {
    const scan = scanErrorResults(`const r = { isError: true, ${RESULT} };`);
    expect(scan.issues.map((i) => i.reason)).toEqual(["missing-details-error"]);
  });

  it("flags details that carries no error key", () => {
    const scan = scanErrorResults(`const r = { isError: true, ${RESULT}, details: { path: p } };`);
    expect(scan.issues.map((i) => i.reason)).toEqual(["missing-details-error"]);
  });

  it("sees through `true as const` (pinchy-email writes its stub that way)", () => {
    // An `expr.kind === TrueKeyword` check skips the literal entirely, which
    // exempts a real result in the tree instead of judging it.
    const scan = scanErrorResults(`const r = { isError: true as const, ${RESULT} };`);
    expect(scan.issues.map((i) => i.reason)).toEqual(["missing-details-error"]);
    expect(scan.checked).toBe(1);
  });

  it("sees through parentheses", () => {
    const scan = scanErrorResults(`const r = { isError: (true), ${RESULT} };`);
    expect(scan.issues.map((i) => i.reason)).toEqual(["missing-details-error"]);
  });

  it("flags a computed isError — the shape pinchy_web_fetch shipped with", () => {
    // `isError: result.isError` forwarded webFetch()'s flag verbatim and
    // carried no details.error on the failure side. A scan that only judges
    // literal `true` cannot see that shape come back.
    const scan = scanErrorResults(`const r = { isError: result.isError, ${RESULT} };`);
    expect(scan.issues.map((i) => i.reason)).toEqual(["dynamic-is-error"]);
    expect(scan.checked).toBe(1);
  });

  it("accepts shorthand details.error", () => {
    // `details: { error }` is correct code; reporting it is the false
    // positive that gets a guard switched off.
    const scan = scanErrorResults(`const r = { isError: true, ${RESULT}, details: { error } };`);
    expect(scan.issues).toEqual([]);
  });

  it("accepts a quoted error key", () => {
    const scan = scanErrorResults(
      `const r = { isError: true, ${RESULT}, details: { "error": msg } };`
    );
    expect(scan.issues).toEqual([]);
  });

  it("ignores a success result", () => {
    const scan = scanErrorResults(`const r = { isError: false, ${RESULT} };`);
    expect(scan.issues).toEqual([]);
    expect(scan.checked).toBe(0);
  });

  it("ignores a result that spreads an already-checked error base", () => {
    // pinchy-email's withEmailAuditDetails re-wraps a toolError() result.
    // The literal it spreads is judged at its own site; re-flagging here
    // would demand a redundant `error` key on every wrapper.
    const scan = scanErrorResults(`const r = { ...base, details: { ...curated, error: e } };`);
    expect(scan.issues).toEqual([]);
    expect(scan.checked).toBe(0);
  });

  it("reports the line of the offending property", () => {
    const scan = scanErrorResults(`const a = 1;\nconst r = {\n  isError: true,\n  ${RESULT},\n};`);
    expect(scan.issues[0]?.line).toBe(3);
  });

  it("finds a result nested inside a function body", () => {
    const scan = scanErrorResults(
      `function f() { if (x) { return { isError: true, ${RESULT} }; } }`
    );
    expect(scan.issues).toHaveLength(1);
  });
});
