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
    // qwen3-coder-next was retired from Ollama Cloud (2026-07-15), along with
    // the whole qwen3-coder family. kimi-k2.7-code is the only coder-specialised
    // model left on the platform, so this is a forced pick, not a ranking.
    coder: "ollama-cloud/kimi-k2.7-code",
    // ministral-3:8b ("smallest practical vision model: 8B, vision+tools") was
    // retired 2026-07-15 with the entire ministral family. There is no small
    // vision model left: the live vision set is gemma4:31b, kimi-k2.5/2.6,
    // minimax-m3 (tools-blocked) and mistral-large-3:675b. So this tier's
    // vision slot cannot be fast AND reliable, and reliability wins — the same
    // trade-off the reasoning tier already made below, for the same reason: a
    // corrupted invoice ref fails the turn outright, which is what the speed
    // was meant to serve.
    //
    // Why kimi-k2.6 and not gemma4:31b, the one small-ish candidate:
    //   - gemma4:31b is 0/12 on duplicate-guard and 0/12 on silent-failure in
    //     the 2026-07-11 sweep — it never verifies before writing, and never
    //     notices a create that did not persist. Both differences from kimi are
    //     statistically significant (diff 0.42, CI [0.09, 0.68]; and 0.33, CI
    //     [0.02, 0.61]); on the easy scenarios the two are tied. The aggregate
    //     read is a TIE (diff -0.107, CI [-0.294, 0.08]) — which is exactly why
    //     the aggregate is the wrong lens: it averages a tie on cheap scenarios
    //     with a significant loss on the two that cost money.
    //   - the id-corruption incident (see the balanced tier) is a long-identifier
    //     failure the invoice scenarios do not probe at all, so the eval's tie
    //     does not clear gemma4 of it — it is an unmeasured risk on top.
    //   - rejecting gemma4 for balanced and reasoning but accepting it here
    //     would be incoherent: carrying refs through a multi-turn tool loop is
    //     this slot's job in every tier.
    vision: "ollama-cloud/kimi-k2.6",
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
    // qwen3-coder:480b retired 2026-07-15 with the rest of the qwen3-coder
    // family; kimi-k2.7-code is the only coder-specialised model still served.
    coder: "ollama-cloud/kimi-k2.7-code",
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
