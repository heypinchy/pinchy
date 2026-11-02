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
// A refused provider stays in the emitted config, pointed at
// `REFUSED_BASE_URL` instead of its saved URL and without its key:
// agents on its models fail at the runtime instead of reaching the refused
// address, the reason is logged, and the AI Provider settings page marks the
// provider as not in use. An unresolvable name (or one whose lookup times
// out) is kept — the guard fails open on DNS errors, as every guard here
// does, so a resolver blip does not take a provider away from every agent.
//
// Why not leave the provider out: a provider's block can be most of
// openclaw.json (one model per entry, and an endpoint can list hundreds).
// Dropping it shrank the file by more than half, which Pinchy's own
// size-drop guard (#311, build.ts) refuses — and so does OpenClaw's
// `config.apply` (`size-drop:OLD->NEW`, no override from the RPC). The
// write was refused, the refused URL stayed live, and so did every later
// config change. Replacing one string keeps the file the size it was.

import {
  assertAllowedProviderUrl,
  memoizeResolver,
  ProviderUrlBlockedError,
  type HostResolver,
} from "@/lib/provider-url-guard";

/**
 * What a refused provider's `baseUrl` becomes in the emitted config.
 *
 * Two locks, either of which holds on its own. The entry carries no key
 * reference (build.ts), and for a non-local base URL OpenClaw then refuses
 * before it opens a connection: `No API key found for provider "<slug>"`
 * (verified against 2026.7.1's auth resolution — it only invents a key for a
 * loopback/LAN/`.local` URL, which is one more reason the saved URL cannot
 * simply stay). And the address cannot be reached: `.invalid` is reserved by
 * RFC 2606 / RFC 6761 so that it never resolves (`getaddrinfo ENOTFOUND
 * base-url-refused.invalid`), and https means even a resolver that answers
 * every name (fake-IP DNS, see upgrading.mdx) leads to a TLS handshake no
 * certificate can complete. OpenClaw's config schema accepts the entry.
 */
export const REFUSED_BASE_URL = "https://base-url-refused.invalid/v1";

interface StoredCustomProvider {
  slug: string;
  displayName: string;
  baseUrl: string;
}

/**
 * Why the SSRF guard refuses this saved base URL, or `null` when it allows it.
 * The reason never names the address. The settings page shows it next to the
 * provider (`GET /api/settings/providers/openai-compatible`), so an admin can
 * see why the provider is not in use — the same verdict
 * {@link refusedBaseUrlsForEmission} acts on.
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
 * The slugs of the providers whose saved base URL the SSRF guard refuses,
 * each with its reason (no address in it). Providers it allows are absent.
 *
 * Each host is looked up once per call, however many providers share it, and
 * a fresh call looks it up again: one call is one regenerate or one request.
 * Does not log — the settings page reads this on every load.
 */
export async function refusedBaseUrlReasons(
  providers: readonly { slug: string; baseUrl: string }[],
  resolver?: HostResolver
): Promise<Map<string, string>> {
  const lookup = memoizeResolver(resolver);
  const reasons = await Promise.all(providers.map((p) => refusedBaseUrlReason(p.baseUrl, lookup)));
  const refused = new Map<string, string>();
  providers.forEach((p, i) => {
    const reason = reasons[i];
    if (reason !== null) refused.set(p.slug, reason);
  });
  return refused;
}

/**
 * {@link refusedBaseUrlReasons} for config emission: the same verdicts, and a
 * log line per refused provider.
 *
 * A refusal is logged, not audited: this runs on every config regenerate, so
 * an audit row here would repeat on each one for as long as the URL stays
 * refused. Nothing changed state — the admin sees the refusal on the provider
 * in Settings → AI Provider instead.
 */
export async function refusedBaseUrlsForEmission(
  providers: readonly StoredCustomProvider[],
  resolver?: HostResolver
): Promise<Map<string, string>> {
  const refused = await refusedBaseUrlReasons(providers, resolver);
  for (const p of providers) {
    const reason = refused.get(p.slug);
    if (reason === undefined) continue;
    // The reason names no address: the log line should not become a list of
    // internal hosts.
    console.warn(
      `[openclaw-config] OpenAI-compatible provider ${p.displayName} (${p.slug}) is not in use: ` +
        `${reason} Its base URL is replaced with a reserved address that never resolves, so ` +
        `agents using its models fail until the URL is changed in Settings → AI Provider or ` +
        `the network policy allows it.`
    );
  }
  return refused;
}
