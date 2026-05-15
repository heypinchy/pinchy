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
import { join } from "node:path";
import {
  E2E_DIR,
  KNOWN_PINCHY_PLUGINS,
  deriveToolsFromSource,
  loadManifest,
} from "./plugin-tool-extraction";

function getPluginTools(pluginId: (typeof KNOWN_PINCHY_PLUGINS)[number]): string[] {
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
    // Pattern 1: literal audit-log query.
    //   /api/audit?eventType=tool.<toolName>&limit=...
    for (const match of content.matchAll(/eventType=tool\.([a-z_]+)/g)) {
      tested.add(match[1]);
    }
    // Pattern 2: call to the shared dispatch-probe helper.
    //   pollAuditForTool(page, { toolName: "<toolName>", ... })
    // We anchor on the helper name so unrelated `toolName: "..."` literals
    // (e.g., internal audit POST bodies for auth tests) are not counted.
    for (const match of content.matchAll(/pollAuditForTool\s*\([\s\S]*?toolName:\s*"([a-z_]+)"/g)) {
      tested.add(match[1]);
    }
  }
  return tested;
}

describe("plugin-tool-coverage", () => {
  const testedTools = getTestedToolsFromE2E();

  for (const pluginId of KNOWN_PINCHY_PLUGINS) {
    it(`${pluginId}: at least one tool covered by an E2E behavior test`, () => {
      const declaredTools = getPluginTools(pluginId);

      // Sidecar plugins (e.g., pinchy-audit) register no agent-facing tools.
      // Nothing to enforce.
      if (declaredTools.length === 0) {
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
