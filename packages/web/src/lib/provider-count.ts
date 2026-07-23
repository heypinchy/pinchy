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

import { PROVIDERS } from "@/lib/providers";
import { getSetting } from "@/lib/settings";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";

/**
 * Total configured providers = configured built-ins (a settings row exists) +
 * the number of custom OpenAI-compatible instances.
 */
export async function countConfiguredProviders(): Promise<number> {
  let builtIns = 0;
  for (const config of Object.values(PROVIDERS)) {
    if ((await getSetting(config.settingsKey)) !== null) builtIns++;
  }
  const custom = await listOpenAiCompatibleProviders();
  return builtIns + custom.length;
}
