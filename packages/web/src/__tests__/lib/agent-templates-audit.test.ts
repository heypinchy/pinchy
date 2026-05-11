import { describe, it, expect } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

// Templates that are explicitly text-only (no attachments expected).
// Each must have a comment in its source file explaining why this is safe.
const TEXT_ONLY_TEMPLATES = new Set(["custom"]);

describe("agent template capability audit", () => {
  for (const [id, t] of Object.entries(AGENT_TEMPLATES)) {
    if (TEXT_ONLY_TEMPLATES.has(id)) continue;
    it(`${id} declares vision capability`, () => {
      expect(t.modelHint?.capabilities).toContain("vision");
    });
    it(`${id} declares documents capability`, () => {
      expect(t.modelHint?.capabilities).toContain("documents");
    });
  }
});
