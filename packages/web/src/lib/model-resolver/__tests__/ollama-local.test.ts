import { describe, expect, it } from "vitest";
import { resolveOllamaLocal } from "../providers/ollama-local";
import { TemplateCapabilityUnavailableError } from "../types";
import type { OllamaLocalModelInfo } from "@/lib/provider-models";

const MODELS: OllamaLocalModelInfo[] = [
  {
    id: "ollama-local/qwen3-coder:30b",
    name: "qwen3-coder:30b",
    parameterSize: "30B",
    capabilities: { vision: false, tools: true, completion: true, thinking: false },
  },
  {
    id: "ollama-local/qwen3-vl:8b",
    name: "qwen3-vl:8b",
    parameterSize: "8B",
    capabilities: { vision: true, tools: true, completion: true, thinking: false },
  },
  {
    id: "ollama-local/llama3.3:70b",
    name: "llama3.3:70b",
    parameterSize: "70B",
    capabilities: { vision: false, tools: true, completion: true, thinking: false },
  },
  {
    id: "ollama-local/deepseek-r1:32b",
    name: "deepseek-r1:32b",
    parameterSize: "32B",
    capabilities: { vision: false, tools: true, completion: true, thinking: true },
  },
];

describe("resolveOllamaLocal", () => {
  it("picks qwen3-coder for coder taskType when available", () => {
    const r = resolveOllamaLocal({ tier: "balanced", taskType: "coder" }, MODELS);
    expect(r.model).toBe("ollama-local/qwen3-coder:30b");
  });

  it("picks qwen3-vl when vision capability required", () => {
    const r = resolveOllamaLocal({ tier: "fast", capabilities: ["vision"] }, MODELS);
    expect(r.model).toBe("ollama-local/qwen3-vl:8b");
  });

  it("throws when vision required but no vision model installed", () => {
    const withoutVision = MODELS.filter((m) => !m.capabilities.vision);
    expect(() =>
      resolveOllamaLocal({ tier: "fast", capabilities: ["vision"] }, withoutVision)
    ).toThrow(TemplateCapabilityUnavailableError);
  });

  it("respects blocklist — skips deepseek-r1 when tools capability required", () => {
    const onlyR1: OllamaLocalModelInfo[] = [MODELS[3]];
    expect(() => resolveOllamaLocal({ tier: "balanced", capabilities: ["tools"] }, onlyR1)).toThrow(
      TemplateCapabilityUnavailableError
    );
  });

  it("falls back to tier-size match when no family match", () => {
    const r = resolveOllamaLocal({ tier: "balanced", taskType: "coder" }, [MODELS[2]]);
    expect(r.model).toBe("ollama-local/llama3.3:70b");
    expect(r.fallbackUsed).toBe(true);
  });

  it("parameterSize maps to tier: <10B=fast, 10-40B=balanced, >40B=reasoning", () => {
    const smallOnly: OllamaLocalModelInfo[] = [MODELS[1]]; // 8B vision
    const r = resolveOllamaLocal({ tier: "fast", capabilities: ["vision"] }, smallOnly);
    expect(r.model).toBe("ollama-local/qwen3-vl:8b");
  });
});
