import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting } from "@/lib/settings";
import { getDefaultModel } from "@/lib/provider-models";
import { getAgentModelBlockReason } from "@/lib/model-resolver/blocklist";

/**
 * Map a qualified model id's leading path segment to its ProviderName.
 *
 * The prefix is NOT always the ProviderName: ollama-local models are minted as
 * `ollama/<model>` (see PROVIDERS["ollama-local"].defaultModel). This mapping
 * is deterministic and — unlike a live-catalog lookup — resolves the provider
 * even for a RETIRED model that has already dropped out of `/v1/models`, which
 * is precisely the state the fallback resolver runs in.
 */
const MODEL_PREFIX_TO_PROVIDER: Record<string, ProviderName> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "ollama-cloud": "ollama-cloud",
  ollama: "ollama-local",
};

function providerOfModel(model: string): ProviderName | null {
  const prefix = model.split("/")[0];
  // `prefix` is a runtime string from a nullable DB column, so this is a genuine
  // dynamic key lookup — but the map is a finite whitelist that returns
  // undefined for anything unrecognized, so no prototype key can leak through.
  // eslint-disable-next-line security/detect-object-injection
  return MODEL_PREFIX_TO_PROVIDER[prefix] ?? null;
}

/**
 * Resolve a SAME-PROVIDER fallback chain for an agent's chat model.
 *
 * The chat model is written verbatim into `agents.*.model` with no fallback,
 * so when a provider retires it upstream (Ollama HTTP 410 "retired") every run
 * dies `410 → next=none → FailoverError/UNAVAILABLE` with nothing rendered, and
 * stays dead because `regenerateOpenClawConfig` just writes the same dead model
 * back (#881). We give OpenClaw a fallback to retry: the provider's LIVE default
 * model, resolved against the current `/v1/models` catalog via `getDefaultModel`
 * — so a retired primary hands off to a live sibling of the SAME provider.
 *
 * Same-provider only (deliberate): Pinchy is a governance product, so an agent
 * must not silently switch to a different provider (cost / data-residency
 * surprise). Cross-provider fallback — the shape the vision chain uses — is a
 * separate, opt-in decision.
 *
 * Returns the fallbacks only (never the primary). Empty when there is no usable
 * fallback; the caller then emits the bare `agent.model` string unchanged.
 */
export async function resolveChatModelFallbackChain(
  primaryModel: string | null | undefined
): Promise<string[]> {
  // agents.model is nullable in the DB — a null/empty primary has no provider
  // and needs no fallback (the caller keeps whatever bare value it had).
  if (!primaryModel) return [];
  const provider = providerOfModel(primaryModel);
  if (!provider) return [];

  // Unconfigured provider → its default would 401 at runtime, so it is not a
  // usable fallback. This is also the state every unit test with null settings
  // hits, which keeps the emitted agent `model` a bare string there.
  // `provider` is a typed ProviderName from a finite map, never user input.
  // eslint-disable-next-line security/detect-object-injection
  const key = await getSetting(PROVIDERS[provider].settingsKey);
  if (!key) return [];

  const liveDefault = await getDefaultModel(provider);
  // `getDefaultModel` contractually returns a non-empty string (it falls back to
  // PROVIDERS[provider].defaultModel), so `!liveDefault` is a defensive guard
  // against future contract drift. The load-bearing check is the equality: if the
  // primary is still live it resolves to itself, and emitting the primary as its
  // own fallback is a dead entry.
  if (!liveDefault || liveDefault === primaryModel) return [];

  // Chat fallbacks drive tool loops, so a blocklisted default (e.g. one that
  // mangles nested tool arguments) must never be handed out — unlike the vision
  // chain, whose slot only describes images and applies no blocklist.
  //
  // DELIBERATE non-recovery: if the provider's live default is itself
  // blocklisted we return [] and the agent keeps its retired bare-string primary
  // — so it stays dead rather than fall back to a tool-mangling model. A
  // permanently-failing agent is the lesser evil versus one that silently
  // corrupts tool calls, and this only bites when the balanced default itself is
  // blocklisted (rare). The root fix for a stale catalog that still offers
  // retired models as selectable defaults is tracked separately in #883.
  if (getAgentModelBlockReason(liveDefault)) return [];

  return [liveDefault];
}
