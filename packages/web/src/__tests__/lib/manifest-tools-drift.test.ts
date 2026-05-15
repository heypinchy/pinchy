// packages/web/src/__tests__/lib/manifest-tools-drift.test.ts
//
// Bidirectional drift guard: every tool listed in contracts.tools must exist
// as a registerTool() call in index.ts, and every registerTool() call in
// index.ts must be listed in contracts.tools. If these diverge, OC 5.3 silently
// ignores tools that are not declared in contracts.tools, causing tools to
// appear registered but never callable.
//
// See AGENTS.md § "Tool dispatch coverage" for the developer recipe.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// From src/__tests__/lib/ → go up 5 levels to reach repo root
const REPO_ROOT = resolve(__dirname, "../../../../..");
const PLUGINS_DIR = join(REPO_ROOT, "packages/plugins");

// Sidecar plugins use hooks, not registerTool() — nothing to drift-guard.
const SIDECAR_ONLY_PLUGINS = new Set(["pinchy-audit"]);

const KNOWN_PINCHY_PLUGINS = [
  "pinchy-files",
  "pinchy-context",
  "pinchy-audit",
  "pinchy-docs",
  "pinchy-email",
  "pinchy-odoo",
  "pinchy-web",
] as const;

type PluginManifest = {
  contracts?: { tools?: string[] };
};

function loadManifest(pluginId: string): PluginManifest {
  const path = join(PLUGINS_DIR, pluginId, "openclaw.plugin.json");
  return JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
}

// Derive tool names from index.ts via the same regex used in plugin-tool-coverage.
// Matches the second registerTool argument pattern:
//   { name: "tool_name" }  or  { name: "tool_name" },
function deriveToolsFromSource(pluginId: string): string[] {
  const indexPath = join(PLUGINS_DIR, pluginId, "index.ts");
  let source: string;
  try {
    source = readFileSync(indexPath, "utf8");
  } catch {
    return [];
  }
  const tools: string[] = [];
  for (const match of source.matchAll(/^\s+\{\s*name:\s*"([a-z_]+)"\s*\}[,;]?\s*$/gm)) {
    tools.push(match[1]);
  }
  return [...new Set(tools)];
}

describe("manifest-tools-drift", () => {
  for (const pluginId of KNOWN_PINCHY_PLUGINS) {
    if (SIDECAR_ONLY_PLUGINS.has(pluginId)) continue;

    it(`${pluginId}: contracts.tools matches registerTool() calls in index.ts`, () => {
      const manifest = loadManifest(pluginId);
      const manifestTools = manifest.contracts?.tools ?? [];
      const sourceTools = deriveToolsFromSource(pluginId);

      if (manifestTools.length === 0 && sourceTools.length === 0) {
        // Plugin has no agent-facing tools — nothing to drift-guard.
        return;
      }

      const missingFromSource = manifestTools.filter((t) => !sourceTools.includes(t));
      expect(
        missingFromSource,
        [
          `Plugin ${pluginId}: contracts.tools lists [${missingFromSource.join(", ")}]`,
          `but these tools are not found as registerTool() calls in index.ts.`,
          `Either remove them from contracts.tools or add registerTool() for each.`,
        ].join("\n")
      ).toHaveLength(0);

      const missingFromManifest = sourceTools.filter((t) => !manifestTools.includes(t));
      expect(
        missingFromManifest,
        [
          `Plugin ${pluginId}: index.ts registers [${missingFromManifest.join(", ")}]`,
          `but these tools are missing from contracts.tools in openclaw.plugin.json.`,
          `Add them to contracts.tools — without it OC 5.3+ silently ignores the tool.`,
        ].join("\n")
      ).toHaveLength(0);
    });
  }
});
