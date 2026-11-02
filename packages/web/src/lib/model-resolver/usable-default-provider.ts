import { getSetting } from "@/lib/settings";
import { PROVIDERS } from "@/lib/providers";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import { refusedBaseUrlReason } from "@/lib/openai-compatible-stored-url";

/**
 * `default_provider` as template model resolution should see it: the setting,
 * except an OpenAI-compatible provider whose saved base URL the SSRF guard now
 * refuses, which reads as no default (`null`).
 *
 * Config emission points such a provider at a reserved address and drops it
 * as the runtime default (openai-compatible-stored-url.ts), so an agent built
 * on `<slug>/<model>` would fail every run. Returning `null` sends every
 * caller down the fallback it already takes before any provider is set up —
 * the same answer the runtime config gives. A refused provider cannot be made
 * the default (`PATCH /api/settings/providers/default`), but one that was the
 * default before its URL became refused still is, until an admin changes it.
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
  return (await refusedBaseUrlReason(match.baseUrl)) === null ? provider : null;
}
