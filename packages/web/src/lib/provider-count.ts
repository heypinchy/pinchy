// Shared configured-provider counting for the last-provider delete guards (#894).
//
// "Configured providers" spans two parallel concepts: the fixed built-in
// providers (keyed by a settings row holding their API key / URL) and the
// dynamic custom "OpenAI-compatible" instances (one DB row each). Both the
// built-in DELETE route and the custom-provider DELETE route (Task 9) must
// refuse removing the *last* provider, so the count that gates them lives here
// once rather than being re-derived — and drifting — in each route.
//
// Kept in its own tiny module (rather than provider-models.ts) so the DELETE
// route doesn't pull the heavy live-model-fetch module — and the route tests
// stay light — while still importing the real counting logic.

import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting } from "@/lib/settings";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";

type ProviderConfig = (typeof PROVIDERS)[ProviderName];

/**
 * The built-in providers that are configured (a settings row exists for their
 * key/URL), in `Object.entries(PROVIDERS)` iteration order.
 *
 * That order is load-bearing: the DELETE route picks the *first* remaining
 * candidate as an orphaned agent's migration target, so preserving it keeps the
 * all-built-ins migration behavior byte-identical. Single source of truth for
 * both the count (last-provider guard) and the migration-target set.
 */
export async function listConfiguredBuiltIns(): Promise<
  { name: ProviderName; config: ProviderConfig }[]
> {
  const configured: { name: ProviderName; config: ProviderConfig }[] = [];
  for (const [name, config] of Object.entries(PROVIDERS)) {
    if ((await getSetting(config.settingsKey)) !== null) {
      configured.push({ name: name as ProviderName, config });
    }
  }
  return configured;
}

/**
 * Total configured providers = configured built-ins (a settings row exists) +
 * the number of custom OpenAI-compatible instances.
 */
export async function countConfiguredProviders(): Promise<number> {
  const builtIns = await listConfiguredBuiltIns();
  const custom = await listOpenAiCompatibleProviders();
  return builtIns.length + custom.length;
}
