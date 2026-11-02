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
 * The size the #311 guard should compare a new payload against: the existing
 * file, minus the bytes of every provider the new payload DELETED — provided at
 * least one provider survives and no surviving provider's catalogue collapsed
 * to empty. A kept provider that shrank is not discounted. Never larger than
 * the existing file, so the guard can only become more permissive, and only by
 * deleted providers' bytes.
 */
export function sizeGuardBaseline(existing: string, next: Json): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return existing.length;
  }
  const existingProviders = providersOf(parsed);
  const nextProviders = providersOf(next);
  if (!isRecord(parsed) || !existingProviders || !nextProviders) return existing.length;
  if (Object.keys(nextProviders).length === 0) return existing.length;
  if (keptProviderCollapsed(existingProviders, nextProviders)) return existing.length;

  const models = parsed.models as Json;
  const kept = Object.fromEntries(
    Object.entries(existingProviders).filter(([key]) => key in nextProviders)
  );
  const withoutDeleted = { ...parsed, models: { ...models, providers: kept } };
  const deletedBytes = serialize(parsed).length - serialize(withoutDeleted).length;
  return existing.length - Math.max(0, deletedBytes);
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
 * its api, and `models: []` (models are then re-added one at a time).
 *
 * Everything else is dropped, and the baseUrl loses userinfo, query and
 * fragment. `ocProvider` comes from `config.get`, which REDACTS credentials —
 * and `config.apply` restores a redacted value from the file at the same path
 * (`restoreRedactedValues`, verified against 2026.7.1). A stub that echoes a
 * redacted `apiKey`, `headers` entry or credential-bearing baseUrl back would
 * have OpenClaw re-write the deleted provider's secret into openclaw.json for
 * every step. `apiKey` would also no longer resolve: secrets.json has lost it.
 */
function providerStub(ocProvider: Json): Json {
  const stub: Json = { baseUrl: inertBaseUrl(ocProvider.baseUrl) };
  if (typeof ocProvider.api === "string") stub.api = ocProvider.api;
  stub.models = [];
  return stub;
}

/** Stands in for a baseUrl that is redacted or unparseable. `.invalid` never resolves (RFC 2606). */
const REMOVED_PROVIDER_BASE_URL = "https://removed-provider.invalid/v1";

function inertBaseUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") return REMOVED_PROVIDER_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // e.g. OpenClaw's `__OPENCLAW_REDACTED__` sentinel for a URL with credentials.
    return REMOVED_PROVIDER_BASE_URL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return REMOVED_PROVIDER_BASE_URL;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

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
