import { describe, it, expect } from "vitest";
import { getSkillBody } from "@/lib/skills";

// A Word chunk with no outline heading carries a null locator, so
// knowledge_search prints the path alone. A skill that demands a position on
// every Sources line makes the model fill the slot with "page number not
// available" — noise to the reader.
describe("knowledge-search skill: a missing position is omitted, not announced", () => {
  const body = getSkillBody("knowledge-search");

  it("marks the position in the Sources template as optional", () => {
    expect(body).toContain("- [1] <document path> — <position, if the passage shows one>");
  });

  it("tells the model to write the path alone and never say a position is missing", () => {
    expect(body).toMatch(/path alone/i);
    expect(body).toMatch(
      /never (say|write|state|announce)[^.]*(missing|unavailable|not available)/i
    );
  });

  it("no longer demands a position unconditionally", () => {
    expect(body).not.toContain("Reproduce the path and the position **exactly**");
  });
});
