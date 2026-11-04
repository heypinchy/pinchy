import { getSetting } from "@/lib/settings";
import { PROVIDERS } from "@/lib/providers";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import { refusedBaseUrlReason } from "@/lib/openai-compatible-stored-url";
import { buildRemainingCandidates } from "@/lib/provider-deletion";

/**
 * `default_provider` as template model resolution should see it: the setting,
 * except an OpenAI-compatible provider whose saved base URL the SSRF guard now
 * refuses. That one is replaced by the first USABLE configured provider, and
 * reads as no default (`null`) only when none is left.
 *
 * Config emission points such a provider at a reserved address and drops it
 * as the runtime default (openai-compatible-stored-url.ts), so an agent built
 * on `<slug>/<model>` would fail every run. The replacement is the provider a
 * removal of the refused one would move agents onto — `buildRemainingCandidates`
 * (built-ins first, refused custom providers left out), shared with the DELETE
 * routes — so a new agent lands on something that runs instead of on the
 * Anthropic anchor callers fall back to with no default, which may not be
 * configured at all. With nothing usable, `null` sends every caller down that
 * fallback, the one it already takes before any provider is set up. A refused
 * provider cannot be made the default (`PATCH /api/settings/providers/default`),
 * but one that was the default before its URL became refused still is, until
 * an admin changes it — this does not change the setting.
 *
 * A built-in name is returned without touching the custom providers; a slug
 * that matches no provider is returned as is, so the resolver keeps failing
 * on it the way it always has.
 */
export async function getUsableDefaultProvider(): Promise<string | null> {
  const provider = await getSetting("default_provider");
  if (provider === null || Object.hasOwn(PROVIDERS, provider)) return provider;

  const match = (await listOpenAiCompatibleProviders()).find((p) => p.slug === provider);
  if (!match) return provider;
  if ((await refusedBaseUrlReason(match.baseUrl)) === null) return provider;

  const [firstUsable] = await buildRemainingCandidates({ excludeCustomId: match.id });
  return firstUsable?.name ?? null;
}
