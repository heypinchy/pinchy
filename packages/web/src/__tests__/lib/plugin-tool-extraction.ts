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
