// packages/web/src/__tests__/lib/plugin-tool-coverage.test.ts
//
// Enforcement guard: every Pinchy plugin that registers agent tools must have
// at least one E2E behavior test that asserts tool dispatch via an audit-log
// query (eventType=tool.<toolName>). If a plugin has tools but no behavior
// test, CI fails here — not silently at runtime.
//
// See AGENTS.md § "Tool dispatch coverage" for the developer recipe.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// From src/__tests__/lib/ → go up 5 levels to reach repo root
const REPO_ROOT = resolve(__dirname, "../../../../..");
const PLUGINS_DIR = join(REPO_ROOT, "packages/plugins");
const E2E_DIR = join(REPO_ROOT, "packages/web/e2e");

// Sidecar plugins loaded via activation.onStartup — they don't register
// agent-facing tools, so there's nothing to test for dispatch.
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
  activation?: { onStartup?: boolean };
};

function loadManifest(pluginId: string): PluginManifest {
  const path = join(PLUGINS_DIR, pluginId, "openclaw.plugin.json");
  return JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
}

// Fallback: derive tool names from index.ts via regex when manifest lacks
// contracts.tools. Matches the second registerTool argument pattern:
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

function getPluginTools(pluginId: string): string[] {
  const manifest = loadManifest(pluginId);
  if (manifest.contracts?.tools && manifest.contracts.tools.length > 0) {
    return manifest.contracts.tools;
  }
  return deriveToolsFromSource(pluginId);
}

function walkSpecFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      result.push(...walkSpecFiles(fullPath));
    } else if (entry.endsWith(".spec.ts")) {
      result.push(fullPath);
    }
  }
  return result;
}

function getTestedToolsFromE2E(): Set<string> {
  const tested = new Set<string>();
  for (const specFile of walkSpecFiles(E2E_DIR)) {
    const content = readFileSync(specFile, "utf8");
    // Audit-log query pattern used by all behavior tests:
    // /api/audit?eventType=tool.<toolName>&limit=...
    for (const match of content.matchAll(/eventType=tool\.([a-z_]+)/g)) {
      tested.add(match[1]);
    }
  }
  return tested;
}

describe("plugin-tool-coverage", () => {
  const testedTools = getTestedToolsFromE2E();

  for (const pluginId of KNOWN_PINCHY_PLUGINS) {
    if (SIDECAR_ONLY_PLUGINS.has(pluginId)) continue;

    it(`${pluginId}: at least one tool covered by an E2E behavior test`, () => {
      const declaredTools = getPluginTools(pluginId);

      if (declaredTools.length === 0) {
        // Plugin has no agent-facing tools — nothing to enforce.
        return;
      }

      const covered = declaredTools.filter((tool) => testedTools.has(tool));

      expect(
        covered,
        [
          `Plugin ${pluginId} declares tools [${declaredTools.join(", ")}]`,
          `but none are covered by an E2E behavior test.`,
          ``,
          `Each tool must have at least one test that:`,
          `  1. sends a chat message with a fake-LLM trigger string,`,
          `  2. fake-Ollama returns a deterministic tool_call for one tool,`,
          `  3. polls /api/audit?eventType=tool.<toolName>&limit=10 for the entry.`,
          ``,
          `See AGENTS.md § "Tool dispatch coverage" for the full recipe.`,
        ].join("\n")
      ).not.toHaveLength(0);
    });
  }
});
