// Size-drop handling for openclaw.json: telling a deliberate shrink apart from
// the #311 DB-state race, and delivering one through OpenClaw's own guard.
//
// Two guards refuse a config that is under half of the one it replaces:
//
//   - Pinchy's, in `regenerateOpenClawConfig` (#311): a regenerate that ran
//     through a window where DB-derived state was not loaded produces a payload
//     missing `channels.telegram`, `bindings`, … — about half the healthy file.
//   - OpenClaw's, in its config writer (2026.7.1: `resolveConfigWriteSuspicious-
//     Reasons` → `size-drop:OLD->NEW` when the next file is under
//     floor(OLD * 0.5) and OLD >= 512 bytes, OLD being the CURRENT openclaw.json).
//     `config.apply`, `config.patch` and `config.set` all commit through that
//     writer and none of them passes `allowConfigSizeDrop`, so no RPC lifts it.
//
// Both are right about a race and both are wrong about one specific shrink: a
// provider being deleted. An OpenAI-compatible provider with 40
// discovered models is most of an install's openclaw.json, so deleting it
// legitimately removes far more than half the file — and the deleted provider
// (with its key reference) stayed live in OpenClaw.
//
// What is deliberate is narrower than "the provider catalog got smaller": a
// provider ABSENT from the next payload is a deletion: provider rows and
// settings are authoritative, and Pinchy refuses to delete the last provider.
// A provider still PRESENT with fewer models is not — its model list comes from
// live discovery, which fails quietly: an Ollama that is unreachable at boot
// answers `[]` (uncached) and is emitted with `models: []`, and timed-out
// `/api/show` calls drop models one by one. Delivering that promotes a
// collapsed catalogue to OpenClaw's last-known-good, and on an offline install
// every agent then fails with "Unknown model". So only deleted providers are
// discounted (guard) or stepped (push); a kept provider's shrink is judged in
// full, and a kept provider whose catalogue collapsed to nothing voids the
// discount altogether — that payload is an empty read, whatever else it does.
// A shrink outside `models.providers` is judged exactly as before.

import { LLAMA_CPP_PROVIDER_ID } from "./paths";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providersOf(config: unknown): Json | undefined {
  if (!isRecord(config) || !isRecord(config.models)) return undefined;
  const providers = config.models.providers;
  return isRecord(providers) ? providers : undefined;
}

function serialize(config: Json): string {
  return JSON.stringify(config, null, 2);
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function modelsOf(provider: unknown): unknown[] {
  return isRecord(provider) && Array.isArray(provider.models) ? provider.models : [];
}

/**
 * True when a provider present in both configs had models before and has none
 * now — a failed discovery read, never a deliberate change.
 */
export function keptProviderCollapsed(before: Json, after: Json): boolean {
  return Object.entries(after).some(
    ([key, provider]) =>
      key in before && modelsOf(before[key]).length > 0 && modelsOf(provider).length === 0
  );
}

/**
 * True when `next` still carries a chat provider. Pinchy refuses to delete the
 * last one, so a payload with none is an empty read, never a deletion.
 * `llama-cpp`, the embedding server, does not count: build.ts emits it on every
 * regenerate, an empty read included.
 */
export function keepsAProvider(next: Json): boolean {
  return Object.keys(providersOf(next) ?? {}).some((key) => key !== LLAMA_CPP_PROVIDER_ID);
}

/** True when `next` no longer lists a provider `existing` does. */
export function deletesAProvider(existing: Json, next: Json): boolean {
  const after = providersOf(next) ?? {};
  return Object.keys(providersOf(existing) ?? {}).some((key) => !(key in after));
}

/**
 * The agent ids in a config's roster: `agents.entries` keyed by id (OpenClaw
 * 2026.9), plus the retired `agents.list` array a file written before the
 * upgrade may still carry. Undefined when the config has neither.
 */
function agentIdsOf(config: unknown): string[] | undefined {
  if (!isRecord(config) || !isRecord(config.agents)) return undefined;
  const { entries, list } = config.agents;
  if (!isRecord(entries) && !Array.isArray(list)) return undefined;
  return [
    ...Object.keys(isRecord(entries) ? entries : {}),
    ...(Array.isArray(list) ? list : [])
      .filter(isRecord)
      .flatMap((a) => (typeof a.id === "string" ? [a.id] : [])),
  ];
}

/** Drop the entries of an id-keyed record whose key is in `ids`. */
function withoutKeys(record: Json, ids: Set<string>): Json {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !ids.has(key)));
}

/**
 * `existing` with everything the DELETED agents own removed: roster entry,
 * per-agent plugin config (`plugins.entries.*.config.agents.<id>`), Telegram
 * account, and bindings. Only the ids the new payload no longer lists are
 * touched, so a kept agent's lost account or bindings (the #311 race) is not
 * discounted.
 */
function withoutDeletedAgents(existing: Json, deleted: Set<string>): Json {
  const pruned: Json = { ...existing };
  const agents = existing.agents as Json;
  pruned.agents = {
    ...agents,
    ...(isRecord(agents.entries) ? { entries: withoutKeys(agents.entries, deleted) } : {}),
    ...(Array.isArray(agents.list)
      ? { list: agents.list.filter((a) => !(isRecord(a) && deleted.has(String(a.id)))) }
      : {}),
  };
  if (Array.isArray(existing.bindings)) {
    pruned.bindings = existing.bindings.filter(
      (b) => !(isRecord(b) && deleted.has(String(b.agentId)))
    );
  }
  if (isRecord(existing.channels) && isRecord(existing.channels.telegram)) {
    const telegram = existing.channels.telegram;
    if (isRecord(telegram.accounts)) {
      pruned.channels = {
        ...existing.channels,
        telegram: { ...telegram, accounts: withoutKeys(telegram.accounts, deleted) },
      };
    }
  }
  if (isRecord(existing.plugins) && isRecord(existing.plugins.entries)) {
    const entries = Object.fromEntries(
      Object.entries(existing.plugins.entries).map(([id, entry]) => {
        if (!isRecord(entry) || !isRecord(entry.config) || !isRecord(entry.config.agents)) {
          return [id, entry];
        }
        const config = { ...entry.config, agents: withoutKeys(entry.config.agents, deleted) };
        return [id, { ...entry, config }];
      })
    );
    pruned.plugins = { ...existing.plugins, entries };
  }
  return pruned;
}

/**
 * The size the #311 guard should compare a new payload against: the existing
 * file, minus the bytes of every provider the new payload DELETED — provided at
 * least one provider survives and no surviving provider's catalogue collapsed
 * to empty — and minus everything each DELETED agent owned, provided at least
 * one agent survives (a payload with none is an empty read, never a deletion).
 * A kept provider that shrank, or a kept agent that lost its Telegram account
 * or bindings, is not discounted. Never larger than the existing file, so the
 * guard can only become more permissive, and only by deleted bytes.
 */
export function sizeGuardBaseline(existing: string, next: Json): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return existing.length;
  }
  if (!isRecord(parsed)) return existing.length;
  const existingProviders = providersOf(parsed);
  const nextProviders = providersOf(next);
  // An empty provider read or a collapsed catalogue voids EVERY discount, the
  // agent one included: that payload is a failed read, and a roster shrink
  // riding along must not carry it past the guard.
  if (
    !existingProviders ||
    !nextProviders ||
    !keepsAProvider(next) ||
    keptProviderCollapsed(existingProviders, nextProviders)
  ) {
    return existing.length;
  }
  const models = parsed.models as Json;
  const kept = Object.fromEntries(
    Object.entries(existingProviders).filter(([key]) => key in nextProviders)
  );
  let pruned: Json = { ...parsed, models: { ...models, providers: kept } };

  const existingAgents = agentIdsOf(parsed);
  const nextAgents = agentIdsOf(next);
  if (existingAgents && nextAgents && nextAgents.length > 0) {
    const deleted = new Set(existingAgents.filter((id) => !nextAgents.includes(id)));
    if (deleted.size > 0) pruned = withoutDeletedAgents(pruned, deleted);
  }

  const discounted = serialize(parsed).length - serialize(pruned).length;
  return existing.length - Math.max(0, discounted);
}

/**
 * Headroom when PREDICTING OpenClaw's refusal before it is made, as a fraction
 * of the current file (at least SIZE_DROP_EXPECTATION_MIN_MARGIN_BYTES).
 * OpenClaw judges the file it would write — meta-stamped, re-serialized —
 * against its own re-serialization of the current one; Pinchy only has its
 * payload and the file. The two errors are not symmetric: expecting a refusal
 * that never comes only turns the file fallback off for one push (which then
 * hands off to a follow-up regenerate), while missing one lets that fallback
 * write a shrink past OpenClaw's guard. So the margin errs towards expecting.
 */
const SIZE_DROP_EXPECTATION_MARGIN = 0.05;
const SIZE_DROP_EXPECTATION_MIN_MARGIN_BYTES = 256;

/**
 * Whether OpenClaw will refuse replacing `existing` with `next` as a size drop
 * (`NEW < floor(OLD * 0.5)`). Measured in UTF-8 bytes as OpenClaw measures it,
 * never in `length`: JavaScript counts UTF-16 units, so a model name in CJK is
 * one unit and three bytes, and a char comparison misses refusals OpenClaw
 * makes. Errs towards true near the threshold (see the margin above).
 */
export function expectsSizeDropRefusal(existing: string, next: string): boolean {
  return expectsSizeDropRefusalAgainst(utf8Bytes(existing), next);
}

/** {@link expectsSizeDropRefusal} against a baseline already counted in UTF-8 bytes. */
export function expectsSizeDropRefusalAgainst(oldBytes: number, next: string): boolean {
  const margin = Math.max(
    SIZE_DROP_EXPECTATION_MIN_MARGIN_BYTES,
    Math.ceil(oldBytes * SIZE_DROP_EXPECTATION_MARGIN)
  );
  return utf8Bytes(next) < Math.floor(oldBytes * 0.5) + margin;
}

export interface SizeDropRejection {
  /** OpenClaw's baseline: the current openclaw.json, in UTF-8 bytes. */
  fromBytes: number;
  /** What OpenClaw would have written for the refused payload, in UTF-8 bytes. */
  toBytes: number;
}

/**
 * Parse OpenClaw's write-side refusal (`Config write rejected: … (size-drop:OLD->NEW)`).
 * The read-side `size-drop-vs-last-good:` anomaly is a different signal and is
 * deliberately not matched.
 */
export function parseSizeDropRejection(message: string): SizeDropRejection | null {
  const match = /\bsize-drop:(\d+)->(\d+)/.exec(message);
  if (!match) return null;
  return { fromBytes: Number(match[1]), toBytes: Number(match[2]) };
}

/**
 * A deleted provider as the smallest valid custom provider: an inert baseUrl,
 * its api, and `models: []` (a step re-adds models one at a time; the
 * key-less bridge keeps them all — keyless-bridge.ts).
 *
 * Nothing of the provider's address on file survives: the stub's baseUrl is
 * {@link REMOVED_PROVIDER_BASE_URL}, or — for a provider the target keeps, in
 * the key-less bridge — the target's own. A stub carries no key, so its address
 * serves nothing — and the address on file was saved under whatever rules held
 * then. One the SSRF guard now refuses (a metadata address) is replaced by
 * REFUSED_BASE_URL in the target (openai-compatible-stored-url.ts); a stub
 * echoing the file's copy would put it back in front of OpenClaw, in every
 * bridge and every step. `ocProvider` also comes from `config.get`, which
 * REDACTS credentials — and `config.apply` restores a redacted value from the
 * file at the same path (`restoreRedactedValues`, verified against 2026.7.1),
 * so echoing a redacted `apiKey`, `headers` entry or credential-bearing
 * baseUrl back would have OpenClaw re-write the deleted provider's secret into
 * openclaw.json for every step. `apiKey` would also no longer resolve:
 * secrets.json has lost it.
 */
export function providerStub(ocProvider: Json, baseUrl = REMOVED_PROVIDER_BASE_URL): Json {
  const stub: Json = { baseUrl };
  if (typeof ocProvider.api === "string") stub.api = ocProvider.api;
  stub.models = [];
  return stub;
}

/** Every stub's baseUrl. `.invalid` never resolves (RFC 2606). */
export const REMOVED_PROVIDER_BASE_URL = "https://removed-provider.invalid/v1";

/**
 * One step of a provider deletion: `target`, plus back as little of the
 * DELETED providers' content OpenClaw still has as keeps the write at or above
 * `minBytes` (UTF-8, as serialized for `config.apply`).
 *
 * A provider the target deleted comes back as a credential-free stub (see
 * {@link providerStub}) and its models are then re-added one at a time. A
 * provider the target KEEPS is sent exactly as the target has it: a shrink
 * inside it is judged in full, never stepped. Nothing outside
 * `models.providers` differs from the target. Returns null when the deleted
 * providers cannot reach `minBytes` — then the shrink is not a deletion, and
 * must not be delivered — and when a kept provider's catalogue collapsed to
 * empty (a failed discovery read; see the header).
 */
export function buildProviderShrinkStep(
  target: Json,
  ocConfig: Json,
  minBytes: number
): Json | null {
  const ocProviders = providersOf(ocConfig);
  if (!ocProviders) return null;

  const targetProviders = providersOf(target) ?? {};
  if (keptProviderCollapsed(ocProviders, targetProviders)) return null;

  // The step's provider entries: the target's, then a stub per provider only
  // OpenClaw still has. `additions` is every model of a deleted provider, in
  // OpenClaw's order — re-added as a prefix.
  const entries = new Map<string, unknown>(Object.entries(structuredClone(targetProviders)));
  const additions: Array<[provider: string, model: Json]> = [];
  for (const [key, ocProvider] of Object.entries(ocProviders)) {
    if (!isRecord(ocProvider) || entries.has(key)) continue;
    entries.set(key, providerStub(ocProvider));
    for (const model of modelsOf(ocProvider).filter(isRecord)) {
      additions.push([key, structuredClone(model)]);
    }
  }

  const targetModels = isRecord(target.models) ? target.models : {};
  const withAdditions = (count: number): Json => {
    const readded = new Map<string, Json[]>();
    for (const [key, model] of additions.slice(0, count)) {
      readded.set(key, [...(readded.get(key) ?? []), model]);
    }
    const providers = Object.fromEntries(
      [...entries].map(([key, entry]) => {
        const more = readded.get(key);
        if (!more || !isRecord(entry)) return [key, entry];
        const models = Array.isArray(entry.models) ? entry.models : [];
        return [key, { ...entry, models: [...models, ...more] }];
      })
    );
    return { ...target, models: { ...targetModels, providers } };
  };
  const size = (count: number) => utf8Bytes(serialize(withAdditions(count)));

  if (size(additions.length) < minBytes) return null;
  // Smallest prefix of additions that reaches minBytes (size is monotonic in it).
  let lo = 0;
  let hi = additions.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (size(mid) >= minBytes) hi = mid;
    else lo = mid + 1;
  }
  return withAdditions(lo);
}

/** OpenClaw skips the size-drop check for a baseline smaller than this. */
const OPENCLAW_SIZE_DROP_MIN_BASELINE_BYTES = 512;

/**
 * Headroom a STEP keeps over OpenClaw's floor(OLD * 0.5), in bytes. Pinchy
 * predicts OpenClaw's byte count from its own serialization plus a calibrated
 * offset (OpenClaw stamps `meta` on every write); the margin absorbs what the
 * offset cannot predict. The target itself is sent as soon as the prediction
 * clears the bare threshold — a margin there would keep a small target from
 * ever qualifying — and a miss just recalibrates from OpenClaw's refusal.
 */
export const SIZE_DROP_MARGIN_BYTES = 256;

export interface ShrinkPushState {
  /** Target config, as Pinchy would send it to `config.apply`. */
  target: string;
  /** OpenClaw's current config (from `config.get`). */
  ocConfig: Json | undefined;
  /** OpenClaw's size-drop baseline: its current openclaw.json, in UTF-8 bytes. */
  ocBaselineBytes: number;
  /** OpenClaw's byte count minus Pinchy's for the same payload. */
  offset: number;
}

/**
 * What to send next while OpenClaw is refusing a shrink: the target once it
 * clears OpenClaw's 50% rule, otherwise the next provider-deletion step. Null
 * when no step can explain the shrink, and when the target collapses a kept
 * provider's catalogue — OpenClaw refused that payload once, and it is a failed
 * discovery read that must not be delivered by any route.
 */
export function planShrinkPush({
  target,
  ocConfig,
  ocBaselineBytes,
  offset,
}: ShrinkPushState): { payload: string; isStep: boolean } | null {
  const parsedTarget = JSON.parse(target) as Json;
  const ocProviders = providersOf(ocConfig);
  if (ocProviders && keptProviderCollapsed(ocProviders, providersOf(parsedTarget) ?? {})) {
    return null;
  }
  const floorHalf = Math.floor(ocBaselineBytes * 0.5);
  if (
    ocBaselineBytes < OPENCLAW_SIZE_DROP_MIN_BASELINE_BYTES ||
    utf8Bytes(target) + offset >= floorHalf
  ) {
    return { payload: target, isStep: false };
  }
  if (!ocConfig) return null;
  const step = buildProviderShrinkStep(
    parsedTarget,
    ocConfig,
    floorHalf + SIZE_DROP_MARGIN_BYTES - offset
  );
  return step ? { payload: serialize(step), isStep: true } : null;
}
