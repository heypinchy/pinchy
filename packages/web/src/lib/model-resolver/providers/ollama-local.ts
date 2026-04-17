import type { OllamaLocalModelInfo } from "@/lib/provider-models";
import { getPreferredFamilies, matchesFamily } from "../families";
import { isBlocked } from "../blocklist";
import { TemplateCapabilityUnavailableError } from "../types";
import type { ModelCapability, ModelHint, ResolverResult } from "../types";

const DOCS_URL = "https://docs.heypinchy.com/guides/ollama-setup#models-for-agent-templates";

function hasCapability(model: OllamaLocalModelInfo, cap: ModelCapability): boolean {
  if (cap === "vision") return model.capabilities.vision;
  if (cap === "tools") return model.capabilities.tools;
  // long-context: heuristic by family (Ollama metadata doesn't expose this)
  if (cap === "long-context") {
    return /qwen|llama-?[3-9]|gemma-?[3-9]|mistral/i.test(model.name);
  }
  return false;
}

function tierOf(model: OllamaLocalModelInfo): "fast" | "balanced" | "reasoning" {
  const gb = parseFloat(model.parameterSize ?? "0");
  if (gb < 10) return "fast";
  if (gb < 40) return "balanced";
  return "reasoning";
}

export function resolveOllamaLocal(
  hint: ModelHint,
  installedModels: OllamaLocalModelInfo[]
): ResolverResult {
  const required = hint.capabilities ?? [];
  const candidates = installedModels
    .filter((m) => required.every((c) => hasCapability(m, c)))
    .filter((m) => !isBlocked(m.id, required));

  if (candidates.length === 0) {
    throw new TemplateCapabilityUnavailableError(required, "ollama-local", DOCS_URL);
  }

  // Try taskType family match at requested tier
  const taskType = hint.taskType ?? "general";
  const families = getPreferredFamilies(taskType);
  for (const family of families) {
    const match = candidates.find((m) => matchesFamily(m.id, family) && tierOf(m) === hint.tier);
    if (match) {
      return {
        model: match.id,
        reason: `ollama-local: family=${family}, tier=${hint.tier}`,
        fallbackUsed: false,
      };
    }
  }

  // Fallback: any candidate at requested tier
  const tierMatch = candidates.find((m) => tierOf(m) === hint.tier);
  if (tierMatch) {
    return {
      model: tierMatch.id,
      reason: `ollama-local: tier=${hint.tier} (no ${taskType} family installed)`,
      fallbackUsed: true,
    };
  }

  // Last resort: any candidate
  return {
    model: candidates[0].id,
    reason: `ollama-local: closest available (no tier=${hint.tier} model installed)`,
    fallbackUsed: true,
  };
}
