import type { ModelCapabilities } from "@/lib/model-capabilities/types";
import type { ModelCapabilityMap } from "@/hooks/use-model-capabilities";

/**
 * Merge the per-model capability map (from `useModelCapabilities`, i.e.
 * `GET /api/models/capabilities`) into a provider list whose models are keyed by
 * the same qualified id (`provider/model`). Each model gains a `capabilities`
 * field so `ModelPicker` can render its capability icons; models absent from the
 * map (or while it's still loading) keep `capabilities: undefined`, which the
 * picker renders icon-free.
 *
 * `/api/providers/models` returns the configured/compatible model list WITHOUT
 * capabilities; this is the client-side join that lights up the picker icons in
 * the agent settings model dropdown.
 */
export function attachCapabilities<M extends { id: string }, P extends { models: M[] }>(
  providers: P[],
  capabilities: ModelCapabilityMap | undefined
): Array<P & { models: Array<M & { capabilities?: ModelCapabilities }> }> {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      capabilities: capabilities?.[model.id],
    })),
  }));
}
