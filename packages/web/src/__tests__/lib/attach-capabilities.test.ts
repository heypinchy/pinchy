import { describe, it, expect } from "vitest";
import { attachCapabilities } from "@/lib/model-capabilities/attach-capabilities";
import type { ModelCapabilities } from "@/lib/model-capabilities/types";

const caps = (over: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  vision: false,
  documents: false,
  audio: false,
  video: false,
  longContext: false,
  tools: false,
  ...over,
});

describe("attachCapabilities", () => {
  it("attaches capabilities to each model by qualified id, preserving other fields", () => {
    const providers = [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [{ id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", compatible: true }],
      },
    ];
    const map = {
      "anthropic/claude-opus-4-7": caps({ vision: true, documents: true, tools: true }),
    };

    const out = attachCapabilities(providers, map);

    expect(out[0].models[0]).toEqual({
      id: "anthropic/claude-opus-4-7",
      name: "Claude Opus 4.7",
      compatible: true,
      capabilities: caps({ vision: true, documents: true, tools: true }),
    });
  });

  it("leaves capabilities undefined for models not present in the map", () => {
    const providers = [{ id: "x", name: "X", models: [{ id: "x/unknown", name: "Unknown" }] }];

    const out = attachCapabilities(providers, { "x/known": caps() });

    expect(out[0].models[0].capabilities).toBeUndefined();
  });

  it("returns providers unchanged (capabilities undefined) when the map is still loading", () => {
    const providers = [
      { id: "x", name: "X", models: [{ id: "x/a", name: "A", compatible: false }] },
    ];

    const out = attachCapabilities(providers, undefined);

    expect(out[0].models[0].capabilities).toBeUndefined();
    expect(out[0].models[0].name).toBe("A");
    expect(out[0].models[0].compatible).toBe(false);
  });

  it("maps capabilities across multiple providers and models", () => {
    const providers = [
      { id: "anthropic", name: "Anthropic", models: [{ id: "anthropic/claude", name: "Claude" }] },
      { id: "openai", name: "OpenAI", models: [{ id: "openai/gpt-5.5", name: "GPT-5.5" }] },
    ];
    const map = {
      "anthropic/claude": caps({ vision: true, longContext: true }),
      "openai/gpt-5.5": caps({ vision: true, tools: true }),
    };

    const out = attachCapabilities(providers, map);

    expect(out[0].models[0].capabilities).toEqual(caps({ vision: true, longContext: true }));
    expect(out[1].models[0].capabilities).toEqual(caps({ vision: true, tools: true }));
  });
});
