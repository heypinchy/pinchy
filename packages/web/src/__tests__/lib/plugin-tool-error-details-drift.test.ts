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
import { describe, it, expect } from "vitest";
import { findMissingErrorDetails, KNOWN_PINCHY_PLUGINS } from "./plugin-error-details-extraction";

describe("plugin-tool-error-details-drift", () => {
  for (const pluginId of KNOWN_PINCHY_PLUGINS) {
    it(`${pluginId}: every isError:true result carries details.error`, () => {
      const issues = findMissingErrorDetails(pluginId);
      expect(
        issues,
        [
          `Plugin ${pluginId}: index.ts returns isError: true without a sibling`,
          `details.error at these locations:`,
          ...issues.map((i) => `  line ${i.line}: ${i.snippet}`),
          ``,
          `OpenClaw strips the isError flag before forwarding a tool result to`,
          `/api/internal/audit/tool-use (#404); details.error is the audit route's`,
          `only remaining failure signal, so a tool call that fails without it is`,
          `audited as outcome: success. Route this error result through a`,
          `toolError()-style helper that sets details: { error: <message> },`,
          `mirroring pinchy-odoo's/pinchy-email's toolError() helper.`,
        ].join("\n")
      ).toHaveLength(0);
    });
  }
});
