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
import {
  KNOWN_PINCHY_PLUGINS,
  deriveToolsFromSource,
  loadManifest,
} from "./plugin-tool-extraction";

describe("manifest-tools-drift", () => {
  for (const pluginId of KNOWN_PINCHY_PLUGINS) {
    it(`${pluginId}: contracts.tools matches registerTool() calls in index.ts`, () => {
      const manifest = loadManifest(pluginId);
      const manifestTools = manifest.contracts?.tools ?? [];
      const sourceTools = deriveToolsFromSource(pluginId);

      // Sidecar plugins (e.g., pinchy-audit) register no agent-facing tools.
      // Both sides are empty, so there is nothing to drift-guard.
      if (manifestTools.length === 0 && sourceTools.length === 0) {
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
