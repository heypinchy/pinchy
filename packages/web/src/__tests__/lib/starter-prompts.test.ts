import { describe, it, expect } from "vitest";
import {
  normalizeStarterPrompts,
  starterPromptsSchema,
  MAX_STARTER_PROMPTS,
  MAX_STARTER_PROMPT_LENGTH,
} from "@/lib/schemas/starter-prompts";

describe("normalizeStarterPrompts", () => {
  it("trims, drops blanks, and de-duplicates while preserving first-seen order", () => {
    expect(normalizeStarterPrompts(["  Hello ", "Hello", "", "   ", "World"])).toEqual([
      "Hello",
      "World",
    ]);
  });

  it("returns an empty array for an all-blank list", () => {
    expect(normalizeStarterPrompts(["", "   ", "\t"])).toEqual([]);
  });

  it("collapses exact duplicates to a single entry (prevents duplicate React keys)", () => {
    expect(normalizeStarterPrompts(["Summarize my inbox", "Summarize my inbox"])).toEqual([
      "Summarize my inbox",
    ]);
  });
});

describe("starterPromptsSchema", () => {
  it("normalizes valid input", () => {
    expect(starterPromptsSchema.parse([" a ", "a", "b"])).toEqual(["a", "b"]);
  });

  it("rejects a prompt longer than MAX_STARTER_PROMPT_LENGTH", () => {
    const long = "x".repeat(MAX_STARTER_PROMPT_LENGTH + 1);
    expect(() => starterPromptsSchema.parse([long])).toThrow();
  });

  it("accepts a prompt exactly at MAX_STARTER_PROMPT_LENGTH", () => {
    const exact = "x".repeat(MAX_STARTER_PROMPT_LENGTH);
    expect(starterPromptsSchema.parse([exact])).toEqual([exact]);
  });

  it("rejects more than MAX_STARTER_PROMPTS entries", () => {
    const many = Array.from({ length: MAX_STARTER_PROMPTS + 1 }, (_, i) => `p${i}`);
    expect(() => starterPromptsSchema.parse(many)).toThrow();
  });
});
