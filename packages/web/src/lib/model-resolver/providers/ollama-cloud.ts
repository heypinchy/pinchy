import type { ModelHint, ModelTaskType, ModelTier, ResolverResult } from "../types";
import type { OllamaCloudModelId } from "@/lib/ollama-cloud-models";

// `OllamaCloudModelId` is a literal-string union derived from the curated
// list in `ollama-cloud-models.ts`. By typing each entry as
// `ollama-cloud/${OllamaCloudModelId}`, any stale or removed model ID
// becomes a TypeScript compile error — the v0.5.0 staging bug
// (`llama3.3:70b → HTTP 404`) would have failed `tsc` here.
type OllamaCloudModelRef = `ollama-cloud/${OllamaCloudModelId}`;

// NOTE: this resolver hardcodes its picks and does NOT filter through
// `isBlocked` at runtime (unlike `ollama-local.ts`, which does). The
// drift-guard test in `__tests__/ollama-cloud.test.ts` ("does NOT return
// a blocked model for any tier's vision slot") is what enforces the
// invariant — if you add or change an entry below that lands in the
// tools-blocklist, that test will fail before the regression ships.
const BY_TIER_FAMILY: Record<
  ModelTier,
  Partial<Record<ModelTaskType, OllamaCloudModelRef>> & {
    general: OllamaCloudModelRef;
    vision: OllamaCloudModelRef;
  }
> = {
  fast: {
    general: "ollama-cloud/deepseek-v4-flash",
    coder: "ollama-cloud/qwen3-coder-next",
    // Smallest practical vision model: 8B, vision+tools, 256K context.
    vision: "ollama-cloud/ministral-3:8b",
  },
  balanced: {
    // glm-4.7 (general) and gemma4:31b (vision) were replaced 2026-07-07
    // after production/staging fallout: glm-4.7 is reasoning-by-default and
    // loops when the `/v1` client drops `reasoning_content` between turns;
    // gemma4:31b corrupted a ~150-char Microsoft Graph message ID across
    // turns ("Id is malformed") in a staging email agent. Deep-research
    // (2026-07-07) plus prior production experience endorse kimi-k2.6 as the
    // strongest non-thinking-preferred tool-driver: vision:true, 256K
    // context, already in the curated catalog (issue #669).
    general: "ollama-cloud/kimi-k2.6",
    coder: "ollama-cloud/qwen3-coder:480b",
    vision: "ollama-cloud/kimi-k2.6",
  },
  reasoning: {
    general: "ollama-cloud/deepseek-v4-pro",
    // qwen3.5:397b was the original pick but only claims vision — the live
    // endpoint hallucinates image contents (see ollama-cloud-models.ts), so it
    // is flagged vision:false and can no longer fill a vision slot.
    // minimax-m3 replaced it on confirmed vision quality, then had to go too:
    // it is now tools-blocked for mangling nested tool arguments (Penny,
    // 2026-07-15 — see blocklist.ts). A vision slot always resolves alongside
    // tools here, so a tools-blocked model cannot fill it, however good its
    // eyes are — the ollama-cloud drift-guards enforce exactly that.
    //
    // That leaves gemma4:31b and kimi-k2.6. gemma4:31b is rejected on the
    // balanced-tier evidence above: it corrupted a ~150-char Graph message ID
    // across turns, and this slot's whole job is carrying invoice numbers and
    // refs through a multi-turn tool loop. kimi-k2.6 is vision+tools with 256K
    // context, already trusted for the balanced tier's vision+general slots,
    // and emitted 0 malformed tool calls across 112 calls in the Penny session
    // that minimax failed. The eval-v1 sweep agrees on aggregate (scorecard
    // table in blocklist.ts): kimi beats gemma4:31b on duplicate, distractor and
    // silent-failure, with gemma4 marginally ahead only on lineitems (11/12 vs
    // 10/12) — an aggregate call, not a rout. The v0.5.3 kimi silent-500 note
    // that previously kept the family out of this slot predates the k2.6
    // catalog entry.
    //
    // Trade-off, deliberate: kimi-k2.6 is a non-thinking-preferred tool-driver,
    // so a reasoning-tier turn that ALSO needs vision loses thinking. Reliable
    // tool calls beat reasoning here — a mangled invoice_line_ids payload fails
    // the turn outright, which is what the reasoning was meant to serve.
    // gemini-3-flash-preview remains blocked (pinchy#344).
    vision: "ollama-cloud/kimi-k2.6",
  },
};

export function resolveOllamaCloud(hint: ModelHint): ResolverResult {
  const tierMap = BY_TIER_FAMILY[hint.tier];

  if (hint.capabilities?.includes("vision")) {
    const model = tierMap.vision;
    return {
      model,
      reason: `ollama-cloud: tier=${hint.tier}, capabilities=vision → ${model}`,
      fallbackUsed: false,
    };
  }

  const taskType = hint.taskType ?? "general";
  const exactMatch = tierMap[taskType];
  const model = exactMatch ?? tierMap.general;
  const fallbackUsed = !exactMatch;
  return {
    model,
    reason: `ollama-cloud: tier=${hint.tier}, taskType=${taskType} → ${model}`,
    fallbackUsed,
  };
}
