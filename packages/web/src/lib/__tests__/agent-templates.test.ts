import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES } from "../agent-templates";

describe("AGENT_TEMPLATES modelHint", () => {
  it("every non-custom template has a valid modelHint with tier", () => {
    for (const [id, tpl] of Object.entries(AGENT_TEMPLATES)) {
      if (id === "custom") continue; // deliberately no hint — user-built agent
      expect(tpl.modelHint, `template "${id}" missing modelHint`).toBeDefined();
      expect(tpl.modelHint?.tier, `template "${id}" has invalid tier`).toMatch(
        /^(fast|balanced|reasoning)$/
      );
    }
  });
});
