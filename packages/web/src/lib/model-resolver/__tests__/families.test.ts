import { describe, expect, it } from "vitest";
import { getPreferredFamilies, matchesFamily } from "../families";

describe("getPreferredFamilies", () => {
  it("returns qwen-coder family first for taskType=coder", () => {
    const families = getPreferredFamilies("coder");
    expect(families[0]).toBe("qwen3-coder");
    expect(families).toContain("qwen2.5-coder");
    expect(families).toContain("deepseek-coder");
  });

  it("returns vision families for taskType=vision", () => {
    const families = getPreferredFamilies("vision");
    expect(families[0]).toBe("qwen3-vl");
    expect(families).toContain("llama3.2-vision");
  });

  it("returns reasoning families for taskType=reasoning", () => {
    const families = getPreferredFamilies("reasoning");
    expect(families).toContain("deepseek-r1");
    expect(families).toContain("phi-4");
  });

  it("returns general-purpose families for taskType=general", () => {
    const families = getPreferredFamilies("general");
    expect(families).toContain("llama3.3");
    expect(families).toContain("qwen3");
  });
});

describe("matchesFamily", () => {
  it("matches by prefix after stripping tag and namespace", () => {
    expect(matchesFamily("ollama-local/qwen3-coder:30b", "qwen3-coder")).toBe(true);
  });

  it("does not match unrelated model", () => {
    expect(matchesFamily("ollama-local/llama3.3:70b", "qwen3-coder")).toBe(false);
  });
});
