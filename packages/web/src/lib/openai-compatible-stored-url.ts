// A saved OpenAI-compatible provider's base URL, checked again at use.
//
// The discover/save routes run `assertAllowedProviderUrl` on what an admin
// types. The value then sits in the database, and config emission hands it to
// OpenClaw as `models.providers.<slug>.baseUrl` on every regeneration —
// OpenClaw sends the chat traffic, with the provider's key, wherever that
// says. A provider saved under older rules, saved before
// `PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS` was set, or whose name now resolves
// somewhere the guard refuses, kept being emitted. Same contract as a stored
// Odoo URL or mail host (`lib/integrations/stored-destination.ts`).
//
// A refused provider is left out of the emitted config, the way a built-in
// provider without a key is: agents on its models fail at the runtime instead
// of reaching the refused address, and the reason is logged. An unresolvable
// name is kept — the guard fails open on DNS errors, as every guard here does,
// so a resolver blip does not take a provider away from every agent.

import {
  assertAllowedProviderUrl,
  ProviderUrlBlockedError,
  type HostResolver,
} from "@/lib/provider-url-guard";

interface StoredCustomProvider {
  slug: string;
  displayName: string;
  baseUrl: string;
}

/**
 * The providers whose saved base URL the SSRF guard still allows, in their
 * original order (the same objects, not copies).
 */
export async function withoutRefusedBaseUrls<T extends StoredCustomProvider>(
  providers: T[],
  resolver?: HostResolver
): Promise<T[]> {
  const verdicts = await Promise.all(
    providers.map(async (p) => {
      try {
        await assertAllowedProviderUrl(p.baseUrl, resolver);
        return true;
      } catch (err) {
        // The guard only throws ProviderUrlBlockedError; anything else is a
        // bug in it, and must not silently drop a provider.
        if (!(err instanceof ProviderUrlBlockedError)) throw err;
        // The message names the reason, never the address: the log line
        // should not become a list of internal hosts.
        console.warn(
          `[openclaw-config] Not emitting OpenAI-compatible provider ${p.displayName} (${p.slug}): ` +
            `${err.message} Agents using its models will fail until its base URL is changed in ` +
            `Settings → AI Provider or the network policy allows it.`
        );
        return false;
      }
    })
  );
  return providers.filter((_, i) => verdicts[i]);
}
