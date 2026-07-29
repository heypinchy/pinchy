// packages/web/src/__tests__/lib/plugin-tool-extraction.ts
//
// Shared test helper for plugin-tool-coverage and manifest-tools-drift tests.
// Reads each plugin's openclaw.plugin.json#contracts.tools and extracts the
// registerTool() names from index.ts. KNOWN_PINCHY_PLUGINS is imported from
// the canonical loader so the guards never drift from the source of truth.
//
// This file is not a *.test.ts and therefore is not executed by Vitest; it is
// only imported from the two drift/coverage test files above.

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import ts from "typescript";
import {
  KNOWN_PINCHY_PLUGINS,
  type KnownPinchyPlugin,
} from "@/lib/openclaw-config/plugin-manifest-loader";

// From src/__tests__/lib/ → go up 5 levels to reach repo root
export const REPO_ROOT = resolve(__dirname, "../../../../..");
export const PLUGINS_DIR = join(REPO_ROOT, "packages/plugins");
export const E2E_DIR = join(REPO_ROOT, "packages/web/e2e");

export { KNOWN_PINCHY_PLUGINS };
export type { KnownPinchyPlugin };

export type PluginManifest = {
  contracts?: { tools?: string[] };
  activation?: { onStartup?: boolean };
};

export function loadManifest(pluginId: KnownPinchyPlugin): PluginManifest {
  const path = join(PLUGINS_DIR, pluginId, "openclaw.plugin.json");
  return JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
}

// Extract every tool name registered via `registerTool()` in a plugin's
// index.ts. Anchors on the literal `registerTool(` token and then matches the
// first `{ name: "X" ... }` opts object that follows. This tolerates:
//   • single-line: `{ name: "x" }`
//   • single-line with extra props: `{ name: "x", description: "y" }`
//   • multi-line opts objects
// False positives are bounded because the `[\s\S]*?` is lazy and anchored
// inside a `registerTool(` call. Pure type-level declarations such as
// `opts?: { name?: string }` are not matched because the value here is a
// quoted string literal, not a type annotation.
export function deriveToolsFromSource(pluginId: KnownPinchyPlugin): string[] {
  const indexPath = join(PLUGINS_DIR, pluginId, "index.ts");
  let source: string;
  try {
    source = readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }
  const tools: string[] = [];
  const pattern = /registerTool\s*\([\s\S]*?\{\s*name:\s*"([a-z_]+)"\s*[,}\s]/g;
  for (const match of source.matchAll(pattern)) {
    tools.push(match[1]);
  }
  return [...new Set(tools)];
}

// ── Skip-aware E2E coverage scan ─────────────────────────────────────────────
//
// A permanently-skipped test is not coverage. Before #834 the coverage guard
// scanned spec files as flat text, so a `eventType=tool.X` reference inside a
// `test.skip` counted for X — and two specs kept dead probes in the tree for
// exactly that reason ("skipped tests count for static scans"). We cut the
// skipped blocks out before matching, so the guard reports on tests that run.
//
// This is the one place in the repo that parses instead of grepping, and it
// pulls the `typescript` module into `pnpm test`. That is deliberate:
// finding where a skipped block ENDS means balancing braces through strings,
// template literals, comments and regex literals, and a guard that gets the
// range wrong either swallows real coverage or waves a skip through — the two
// failures it exists to prevent. Everywhere the answer is a token rather than
// a range, the other guards' regexes stay the right tool. `typescript` is
// externalized in vitest.config.ts so vite does not transform it — that costs
// nothing measurable, whereas transforming it costs ~11s and prints a
// sourcemap ENOENT stack on every run.

const SKIP_MEMBERS = new Set(["skip", "todo", "fixme"]);
const SKIP_BARE_NAMES = new Set(["xit", "xdescribe"]);
const TEST_OBJECTS = new Set(["test", "it", "describe"]);

/**
 * True for the callee of a skipped test/suite call: `test.skip`, `it.todo`,
 * `describe.fixme`, the chained `test.describe.skip`, and bare `xit`/
 * `xdescribe`. Deliberately NOT `.skipIf(...)` — that's a runtime gate on an
 * env var or an OS feature, the same carve-out the skip policy makes.
 *
 * Kept in sync with eslint-rules/no-untracked-skips.js by hand; the skip
 * syntaxes are a closed set that both files spell out.
 */
function isSkipCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return SKIP_BARE_NAMES.has(expr.text);
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (!SKIP_MEMBERS.has(expr.name.text)) return false;

  // Walk the whole property chain to its root identifier rather than checking
  // a fixed depth: `test.skip`, `test.describe.skip` and Playwright's
  // `test.describe.serial.skip` / `.parallel.skip` are all the same thing, and
  // a guard that stops at two levels quietly starts counting the longer forms
  // as coverage again.
  let base: ts.Expression = expr.expression;
  while (ts.isPropertyAccessExpression(base)) base = base.expression;
  return ts.isIdentifier(base) && TEST_OBJECTS.has(base.text);
}

/**
 * Character ranges of every skipped test/suite call in a spec's source, as
 * `[start, end)` offsets. A skipped `describe` yields ONE range covering its
 * whole body — nested tests inside it never run either, so there is nothing
 * to descend into.
 */
export function skippedRanges(source: string): Array<[number, number]> {
  const sourceFile = ts.createSourceFile(
    "spec.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
  const ranges: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isSkipCallee(node.expression)) {
      ranges.push([node.getStart(sourceFile), node.getEnd()]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return ranges;
}

/**
 * Tool names a spec's source proves are dispatched, via either of the two
 * assertion shapes AGENTS.md § "Tool dispatch coverage" prescribes:
 *
 *   1. a literal audit query — `/api/audit?eventType=tool.<name>&limit=…`
 *   2. the shared helper — `pollAuditForTool(page, { toolName: "<name>", … })`
 *
 * Pattern 2 is anchored on the helper name so unrelated `toolName: "…"`
 * literals (e.g. an audit POST body in an auth test) are not counted. Its gap
 * matcher is `[^)]*?`, not `[\s\S]*?`: the tool name must sit inside the
 * call's own argument list. Otherwise a prose mention of `pollAuditForTool(`
 * — the kind this policy's own explanatory comments contain — runs on until
 * it finds a `toolName:` literal somewhere later in the file, quite possibly
 * inside the skipped block it was explaining.
 *
 * Skippedness is judged at the offset of the captured tool name, not at the
 * match start, for the same reason: the thing that has to be inside a running
 * test is the name, not whatever text the match happened to begin at.
 */
export function extractCoveredTools(source: string): string[] {
  const skipped = skippedRanges(source);
  const isSkipped = (offset: number): boolean =>
    skipped.some(([start, end]) => offset >= start && offset < end);

  const tools = new Set<string>();
  for (const pattern of [
    /eventType=tool\.([a-z_]+)/g,
    /pollAuditForTool\s*\([^)]*?toolName:\s*"([a-z_]+)"/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const nameOffset = match.index + match[0].lastIndexOf(match[1]);
      if (isSkipped(nameOffset)) continue;
      tools.add(match[1]);
    }
  }
  return [...tools];
}
