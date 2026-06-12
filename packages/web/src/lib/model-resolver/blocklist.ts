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
  // Do NOT remove this rule when pinchy#344 / openclaw#72879 (thought_signature
  // drop) are fixed upstream. The plain-text tool-call leak — "default_api"
  // calls emitted as assistant text instead of structured tool_calls — is
  // Gemini-family model behavior, reproduced even on Google's native API
  // (livekit/agents#5662) and observed in production on 2026-06-11
  // (ollama-cloud/gemini-3-flash-preview). Lifting this block requires a fresh
  // multi-round tool probe against the live endpoint, not just closed issues.
  {
    modelPattern: /-preview\b/i,
    forbiddenWhen: ["tools"],
    reason:
      "Preview models (e.g. gemini-3-flash-preview) are unstable for tools+vision: silent hangs and schema-rejection errors observed in production (pinchy#344, pinchy#338)",
  },
];

export function isBlocked(modelId: string, requiredCapabilities: ModelCapability[]): boolean {
  return RULES.some(
    (rule) =>
      rule.modelPattern.test(modelId) &&
      rule.forbiddenWhen.some((c) => requiredCapabilities.includes(c))
  );
}

/**
 * Returns every distinct `forbiddenWhen` capability-set across all blocklist
 * rules. Exposed so resolver drift-guards can iterate over current rules
 * instead of hard-coding `["tools"]`. Add a new rule with a new forbidden
 * capability and the drift-guards automatically cover it.
 */
export function getForbiddenCapabilitySets(): ReadonlyArray<readonly ModelCapability[]> {
  return RULES.map((r) => r.forbiddenWhen);
}
