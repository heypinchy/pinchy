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
// buys ~1s of `typescript` module load in `pnpm test`. That is deliberate:
// finding where a skipped block ENDS means balancing braces through strings,
// template literals, comments and regex literals, and a guard that gets the
// range wrong either swallows real coverage or waves a skip through — the two
// failures it exists to prevent. Everywhere the answer is a token rather than
// a range, the other guards' regexes stay the right tool.

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

  const base = expr.expression;
  // `test.skip` / `it.todo` / `describe.fixme`
  if (ts.isIdentifier(base)) return TEST_OBJECTS.has(base.text);
  // `test.describe.skip`
  if (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression)) {
    return TEST_OBJECTS.has(base.expression.text);
  }
  return false;
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
 * literals (e.g. an audit POST body in an auth test) are not counted.
 * Matches inside a skipped block are dropped.
 */
export function extractCoveredTools(source: string): string[] {
  const skipped = skippedRanges(source);
  const isSkipped = (offset: number): boolean =>
    skipped.some(([start, end]) => offset >= start && offset < end);

  const tools = new Set<string>();
  for (const pattern of [
    /eventType=tool\.([a-z_]+)/g,
    /pollAuditForTool\s*\([\s\S]*?toolName:\s*"([a-z_]+)"/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match.index !== undefined && isSkipped(match.index)) continue;
      tools.add(match[1]);
    }
  }
  return [...tools];
}
