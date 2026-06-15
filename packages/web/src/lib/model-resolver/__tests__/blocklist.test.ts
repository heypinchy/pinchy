import { describe, expect, it } from "vitest";
import {
  getBlockReason,
  getForbiddenCapabilitySets,
  isBlocked,
  markToolBlockedModels,
} from "../blocklist";

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

describe("getBlockReason", () => {
  it("returns the rule reason when a model is blocked for the required capabilities", () => {
    const reason = getBlockReason("gemini-3-flash-preview", ["tools"]);
    expect(reason).toBeTruthy();
    expect(reason).toContain("Preview models");
  });

  it("returns the deepseek-specific reason for deepseek-r1 + tools", () => {
    expect(getBlockReason("deepseek-r1:32b", ["tools"])).toContain("DeepSeek-R1");
  });

  it("returns null when the model is not blocked for the given capabilities", () => {
    expect(getBlockReason("gemini-3-flash-preview", ["vision"])).toBeNull();
    expect(getBlockReason("qwen3-vl:235b", ["tools"])).toBeNull();
  });

  it("agrees with isBlocked: non-null reason iff blocked", () => {
    for (const [model, caps] of [
      ["gemini-3-flash-preview", ["tools"]],
      ["deepseek-r1:32b", ["tools"]],
      ["qwen3-vl:235b", ["tools"]],
      ["gemini-3-flash-preview", []],
    ] as const) {
      expect(getBlockReason(model, [...caps]) !== null).toBe(isBlocked(model, [...caps]));
    }
  });
});

describe("markToolBlockedModels", () => {
  it("marks a tools-blocklisted model incompatible with the block reason, leaving others untouched", () => {
    const out = markToolBlockedModels([
      {
        id: "ollama-cloud",
        models: [
          { id: "ollama-cloud/gemini-3-flash-preview", name: "gemini", compatible: true },
          { id: "ollama-cloud/qwen3-vl:235b", name: "qwen", compatible: true },
        ],
      },
    ]);
    expect(out[0].models[0].compatible).toBe(false);
    expect(out[0].models[0].incompatibleReason).toContain("Preview models");
    expect(out[0].models[1].compatible).toBe(true);
    expect(out[0].models[1].incompatibleReason).toBeUndefined();
  });

  it("preserves an existing provider incompatibility reason rather than overwriting it", () => {
    const out = markToolBlockedModels([
      {
        id: "p",
        models: [
          {
            id: "x/some-model",
            name: "x",
            compatible: false,
            incompatibleReason: "Provider not configured",
          },
        ],
      },
    ]);
    expect(out[0].models[0].incompatibleReason).toBe("Provider not configured");
  });

  it("leaves reliable models untouched", () => {
    const out = markToolBlockedModels([
      {
        id: "anthropic",
        models: [{ id: "anthropic/claude-opus-4-8", name: "c", compatible: true }],
      },
    ]);
    expect(out[0].models[0].compatible).toBe(true);
    expect(out[0].models[0].incompatibleReason).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const input = [
      { id: "p", models: [{ id: "x/gemini-3-flash-preview", name: "g", compatible: true }] },
    ];
    markToolBlockedModels(input);
    expect(input[0].models[0].compatible).toBe(true);
    expect(input[0].models[0]).not.toHaveProperty("incompatibleReason");
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
