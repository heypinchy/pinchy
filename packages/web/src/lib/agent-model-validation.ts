import { fetchProviderModels } from "@/lib/provider-models";
import { getAgentModelBlockReason } from "@/lib/model-resolver/blocklist";

/**
 * Validates that a qualified model id (`provider/model`) can actually serve
 * an agent: it must appear in a CONFIGURED provider's model list and not be
 * flagged incompatible there.
 *
 * This is the server-side invariant behind every model-changing write path —
 * UI pickers may filter, but only this check prevents an agent from being
 * pointed at a provider with no API key (which silently breaks every chat).
 *
 * Returns an error message suitable for a structured 400 response, or null
 * when the model is available.
 */
export async function validateAgentModel(model: string): Promise<string | null> {
  const providers = await fetchProviderModels();
  for (const provider of providers) {
    const match = provider.models.find((m) => m.id === model);
    if (!match) continue;
    if (match.compatible === false) {
      return match.incompatibleReason ?? `Model ${model} is not compatible with agents`;
    }
    // The provider reporting `compatible` only means "key configured + supports
    // agents" — it does NOT mean the model is reliable for tool-calling. Reject
    // models the tools-blocklist flags (e.g. `gemini-3-flash-preview`, whose
    // multi-turn tool calls Gemini rejects over the ollama-cloud path). The
    // route only calls this when the model actually changes, so an agent already
    // on a blocked model can still save other fields — this gates new picks only.
    const blockReason = getAgentModelBlockReason(model);
    if (blockReason) return blockReason;
    return null;
  }
  return `Model ${model} is not available — its provider is not configured`;
}
