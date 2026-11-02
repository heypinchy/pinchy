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
// of reaching the refused address, the reason is logged, and the AI Provider
// settings page marks the provider as not in use. An unresolvable
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
 * Why the SSRF guard refuses this saved base URL, or `null` when it allows it.
 * The reason never names the address. The settings page shows it next to the
 * provider (`GET /api/settings/providers/openai-compatible`), so an admin can
 * see why the provider is left out of the config — the same verdict
 * {@link withoutRefusedBaseUrls} acts on.
 */
export async function refusedBaseUrlReason(
  baseUrl: string,
  resolver?: HostResolver
): Promise<string | null> {
  try {
    await assertAllowedProviderUrl(baseUrl, resolver);
    return null;
  } catch (err) {
    // The guard only throws ProviderUrlBlockedError; anything else is a bug in
    // it, and must not silently drop (or flag) a provider.
    if (!(err instanceof ProviderUrlBlockedError)) throw err;
    return err.message;
  }
}

/**
 * The providers whose saved base URL the SSRF guard still allows, in their
 * original order (the same objects, not copies).
 *
 * A refusal is logged, not audited: this runs on every config regenerate, so
 * an audit row here would repeat on each one for as long as the URL stays
 * refused. Nothing changed state — the admin sees the refusal on the provider
 * in Settings → AI Provider instead.
 */
export async function withoutRefusedBaseUrls<T extends StoredCustomProvider>(
  providers: T[],
  resolver?: HostResolver
): Promise<T[]> {
  const reasons = await Promise.all(
    providers.map((p) => refusedBaseUrlReason(p.baseUrl, resolver))
  );
  providers.forEach((p, i) => {
    const reason = reasons[i];
    if (reason === null) return;
    // The reason names no address: the log line should not become a list of
    // internal hosts.
    console.warn(
      `[openclaw-config] Not emitting OpenAI-compatible provider ${p.displayName} (${p.slug}): ` +
        `${reason} Agents using its models will fail until its base URL is changed in ` +
        `Settings → AI Provider or the network policy allows it.`
    );
  });
  return providers.filter((_, i) => reasons[i] === null);
}
