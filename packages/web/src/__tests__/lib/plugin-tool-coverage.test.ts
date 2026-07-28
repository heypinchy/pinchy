// packages/web/src/__tests__/lib/plugin-tool-coverage.test.ts
//
// Enforcement guard: every Pinchy plugin that registers agent tools must have
// at least one E2E behavior test that asserts tool dispatch via an audit-log
// query (eventType=tool.<toolName>). If a plugin has tools but no behavior
// test, CI fails here — not silently at runtime.
//
// A permanently-skipped probe does NOT count (#834). The scan drops matches
// inside `test.skip` / `test.describe.skip` blocks, so this guard reports on
// tests that run rather than on strings that exist — see extractCoveredTools
// in ./plugin-tool-extraction and its unit tests in
// ./plugin-tool-coverage-skips.test.ts.
//
// See AGENTS.md § "Tool dispatch coverage" for the developer recipe.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  E2E_DIR,
  KNOWN_PINCHY_PLUGINS,
  deriveToolsFromSource,
  extractCoveredTools,
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
    for (const tool of extractCoveredTools(readFileSync(specFile, "utf8"))) {
      tested.add(tool);
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
          `A probe inside a test.skip / test.describe.skip does NOT count — the`,
          `assertion never runs, so it proves nothing. Un-skip it or write one`,
          `that runs.`,
          ``,
          `See AGENTS.md § "Tool dispatch coverage" for the full recipe.`,
        ].join("\n")
      ).not.toHaveLength(0);
    });
  }
});
