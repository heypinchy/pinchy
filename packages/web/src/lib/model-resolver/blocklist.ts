import type { ModelCapability } from "./types";

interface BlockRule {
  modelPattern: RegExp;
  forbiddenWhen: ModelCapability[];
  reason: string;
}

const RULES: BlockRule[] = [
  {
    modelPattern: /deepseek-r1/i,
    forbiddenWhen: ["tools"],
    reason: "DeepSeek-R1 tool-calling unreliable without reasoning:false flag",
  },
];

export function isBlocked(modelId: string, requiredCapabilities: ModelCapability[]): boolean {
  return RULES.some(
    (rule) =>
      rule.modelPattern.test(modelId) &&
      rule.forbiddenWhen.some((c) => requiredCapabilities.includes(c))
  );
}
