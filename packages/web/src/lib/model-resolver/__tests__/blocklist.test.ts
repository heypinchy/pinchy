import { describe, expect, it } from "vitest";
import { getForbiddenCapabilitySets, isBlocked } from "../blocklist";

describe("isBlocked", () => {
  it("blocks deepseek-r1 when tools capability is required", () => {
    expect(isBlocked("deepseek-r1:32b", ["tools"])).toBe(true);
  });

  it("allows deepseek-r1 without tools requirement", () => {
    expect(isBlocked("deepseek-r1:32b", [])).toBe(false);
  });

  it("allows generic reliable models", () => {
    expect(isBlocked("qwen3:32b", ["tools"])).toBe(false);
  });

  it("blocks gemini-3-flash-preview when tools capability is required", () => {
    expect(isBlocked("gemini-3-flash-preview", ["tools"])).toBe(true);
  });

  it("blocks gemini-3-flash-preview when vision+tools is required", () => {
    expect(isBlocked("gemini-3-flash-preview", ["vision", "tools"])).toBe(true);
  });

  it("allows gemini-3-flash-preview without tools requirement", () => {
    expect(isBlocked("gemini-3-flash-preview", ["vision"])).toBe(false);
    expect(isBlocked("gemini-3-flash-preview", [])).toBe(false);
  });

  it("blocks any preview-suffixed model when tools is required", () => {
    expect(isBlocked("gemini-2.5-flash-preview", ["tools"])).toBe(true);
    expect(isBlocked("some-new-model-preview", ["tools"])).toBe(true);
  });

  it("does not block stable gemini models", () => {
    expect(isBlocked("gemini-2.5-pro", ["tools"])).toBe(false);
    expect(isBlocked("gemini-2.5-flash-lite", ["tools"])).toBe(false);
  });
});

describe("getForbiddenCapabilitySets", () => {
  it("returns one entry per rule, each a non-empty capability list", () => {
    const sets = getForbiddenCapabilitySets();
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(set.length).toBeGreaterThan(0);
    }
  });

  it("includes the tools capability (current rules all forbid tools)", () => {
    const sets = getForbiddenCapabilitySets();
    const flattened = sets.flatMap((s) => [...s]);
    expect(flattened).toContain("tools");
  });
});
