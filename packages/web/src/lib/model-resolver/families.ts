import type { ModelTaskType } from "./types";

const FAMILIES: Record<ModelTaskType, string[]> = {
  coder: ["qwen3-coder", "qwen2.5-coder", "deepseek-coder"],
  vision: ["qwen3-vl", "qwen2.5vl", "gemma3", "llama3.2-vision"],
  reasoning: ["deepseek-r1", "phi-4", "qwen3"],
  general: ["llama3.3", "qwen3", "glm-4.7-flash"],
};

export function getPreferredFamilies(taskType: ModelTaskType): string[] {
  return FAMILIES[taskType];
}

export function matchesFamily(modelId: string, family: string): boolean {
  const normalized = modelId.toLowerCase().split(":")[0].split("/").pop() ?? "";
  return normalized.startsWith(family.toLowerCase());
}
