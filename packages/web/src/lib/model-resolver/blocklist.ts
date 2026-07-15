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
  // Observed in production 2026-07-15 (agent "Penny", ollama-cloud stack). The
  // model emits structurally broken tool arguments: every NESTED array collapses
  // into an {"item": ...} object, and some arrays arrive stringified ("[10, 20]").
  // That destroys exactly the payloads bookkeeping needs — Odoo domain filters
  // ("unhashable type: 'dict'") and account.move invoice_line_ids/tax_ids command
  // triplets. It also emits positional instead of named arguments, so every field
  // lands in the schema's first property. Measured over one session: 20 of 60
  // minimax-m3 tool calls mangled, versus 0 of 112 on kimi-k2.6 and 0 of 68 on
  // deepseek-v4-pro — model behavior, not a Pinchy serialization bug. Like the
  // preview rule it is seeded tools:true, so it would otherwise win same-provider
  // vision fallback for a text-only agent. Lifting this block requires a fresh
  // multi-round tool probe with NESTED-array arguments against the live endpoint.
  //
  // The pattern has NO trailing boundary on purpose, so it also covers point
  // releases of the same line: the catalog names them `minimax-m2.1`, `m2.5`,
  // `m2.7`, so a future `minimax-m3.5` is the expected shape, and a substring
  // match blocks it too. That is the fail-safe direction and it is not silent —
  // the catalog is hand-curated, so adding `minimax-m3.5` means editing
  // ollama-cloud-models.ts and meeting this rule. A release claiming the fix
  // still has to earn the unblock with a nested-array probe, which the current
  // flat probe cannot give (scripts/lib/ollama-cloud-tool-probe.mjs).
  //
  // A new major line (`minimax-m4`) deliberately does NOT match. There is no
  // evidence about it, and this blocklist is an evidence-based denylist — every
  // model not named here is allowed. Blocking an unseen model by guessing at its
  // name would be a different policy than the other two rules follow.
  {
    modelPattern: /minimax-m3/i,
    forbiddenWhen: ["tools"],
    reason:
      'minimax-m3 mangles nested tool-call arguments (arrays collapse to {"item": ...}), breaking Odoo domain filters and invoice line commands (observed in production 2026-07-15)',
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

/** The reason an agent chat model is tool-blocked, or null. For settings warnings. */
export function getAgentModelBlockReason(modelId: string): string | null {
  return getBlockReason(modelId, AGENT_MODEL_REQUIRED_CAPABILITIES);
}
