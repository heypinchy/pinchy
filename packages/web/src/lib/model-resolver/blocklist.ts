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
  return getBlockReason(modelId, requiredCapabilities) !== null;
}

/**
 * Returns the human-readable reason a model is blocked for the given required
 * capabilities, or null when it is not blocked. Same matching as `isBlocked`,
 * but surfaces the rule's `reason` so callers (model picker, agent-model write
 * validation, settings warning) can tell the user WHY a model is unsuitable
 * instead of silently failing at runtime — the gap that left agents stuck on
 * tool-broken models like `gemini-3-flash-preview`.
 */
export function getBlockReason(
  modelId: string,
  requiredCapabilities: ModelCapability[]
): string | null {
  const rule = RULES.find(
    (r) =>
      r.modelPattern.test(modelId) && r.forbiddenWhen.some((c) => requiredCapabilities.includes(c))
  );
  return rule?.reason ?? null;
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

// Every Pinchy agent drives a function-calling loop, so its chat model always
// needs to be tool-reliable (see agent-model-validation.ts for the same
// rationale). Kept here so the picker transform and predicate share one source.
const AGENT_MODEL_REQUIRED_CAPABILITIES: ModelCapability[] = ["tools"];

/**
 * Returns a copy of a model-picker provider list with every model the
 * tools-blocklist flags marked `compatible: false` plus the rule's reason, so
 * the picker disables it with an explanation — the same treatment configured
 * providers already give models without an API key. Models that are already
 * incompatible keep their existing reason; reliable models pass through
 * untouched. Pure and non-mutating.
 */
export function markToolBlockedModels<
  M extends { id: string; compatible?: boolean; incompatibleReason?: string },
  P extends { models: M[] },
>(providers: P[]): P[] {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => {
      if (model.compatible === false) return model;
      const blockReason = getBlockReason(model.id, AGENT_MODEL_REQUIRED_CAPABILITIES);
      if (!blockReason) return model;
      return { ...model, compatible: false, incompatibleReason: blockReason };
    }),
  }));
}

/** True when the given agent chat model is flagged unreliable for tool use. */
export function isAgentModelToolBlocked(modelId: string): boolean {
  return isBlocked(modelId, AGENT_MODEL_REQUIRED_CAPABILITIES);
}

/** The reason an agent chat model is tool-blocked, or null. For settings warnings. */
export function getAgentModelBlockReason(modelId: string): string | null {
  return getBlockReason(modelId, AGENT_MODEL_REQUIRED_CAPABILITIES);
}
