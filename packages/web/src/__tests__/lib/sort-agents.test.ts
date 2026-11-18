import { describe, it, expect } from "vitest";
import { sortAgents } from "@/lib/sort-agents";

describe("sortAgents", () => {
  it("puts personal agents first, then sorts by name", () => {
    const sorted = sortAgents([
      { id: "b", name: "Beta", isPersonal: false },
      { id: "p", name: "Zed", isPersonal: true },
      { id: "a", name: "Alpha", isPersonal: false },
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["p", "a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [
      { id: "b", name: "Beta", isPersonal: false },
      { id: "a", name: "Alpha", isPersonal: false },
    ];
    sortAgents(input);
    expect(input.map((a) => a.id)).toEqual(["b", "a"]);
  });
});
