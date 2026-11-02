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
// provider catalog getting smaller. An OpenAI-compatible provider with 40
// discovered models is most of an install's openclaw.json, so deleting it
// legitimately removes far more than half the file — and the deleted provider
// (with its key reference) stayed live in OpenClaw.
//
// Provider catalogs are rebuilt on every regenerate from authoritative reads
// (provider rows, provider settings, live discovery), and Pinchy refuses to
// delete the last provider. So a payload that still carries at least one
// provider is not an empty read, and its catalog shrink is deliberate. Nothing
// else gets that benefit: a shrink outside `models.providers` is judged exactly
// as before.

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

/**
 * The size the #311 guard should compare a new payload against: the existing
 * file, minus whatever the provider catalog shrank by — provided the new payload
 * still has at least one provider. Never larger than the existing file, so the
 * guard can only become more permissive, and only for provider catalogs.
 */
export function sizeGuardBaseline(existing: string, next: Json): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return existing.length;
  }
  const nextProviders = providersOf(next);
  if (!isRecord(parsed) || !providersOf(parsed) || !nextProviders) return existing.length;
  if (Object.keys(nextProviders).length === 0) return existing.length;

  const models = parsed.models as Json;
  const withNextCatalog = { ...parsed, models: { ...models, providers: nextProviders } };
  const catalogShrink = serialize(parsed).length - serialize(withNextCatalog).length;
  return existing.length - Math.max(0, catalogShrink);
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
 * One step of a provider-catalog shrink: `target`, plus back as little of
 * OpenClaw's current provider content as keeps the write at or above `minBytes`
 * (UTF-8, as serialized for `config.apply`).
 *
 * A provider the target deleted comes back as a keyless stub (`apiKey` dropped:
 * secrets.json no longer resolves it, and OpenClaw rejects an unresolvable
 * SecretRef) with `models: []` — the smallest shape OpenClaw accepts for a
 * custom provider — and models are then re-added one at a time. Nothing outside
 * `models.providers` differs from the target. Returns null when even all of
 * OpenClaw's provider content cannot reach `minBytes`: then the shrink is not a
 * provider catalog shrink, and must not be delivered.
 */
export function buildProviderShrinkStep(
  target: Json,
  ocConfig: Json,
  minBytes: number
): Json | null {
  const ocProviders = providersOf(ocConfig);
  if (!ocProviders) return null;

  // The step's provider entries: the target's, then a stub per provider only
  // OpenClaw still has. `additions` is every model OpenClaw has that the step
  // lacks, in OpenClaw's order — re-added as a prefix.
  const entries = new Map<string, unknown>(
    Object.entries(structuredClone(providersOf(target) ?? {}))
  );
  const additions: Array<[provider: string, model: Json]> = [];
  for (const [key, ocProvider] of Object.entries(ocProviders)) {
    if (!isRecord(ocProvider)) continue;
    const ocModels = (Array.isArray(ocProvider.models) ? ocProvider.models : []).filter(isRecord);
    const entry = entries.get(key);
    let missing = ocModels;
    if (isRecord(entry)) {
      const kept = new Set<unknown>(
        (Array.isArray(entry.models) ? entry.models : []).map((m) => (isRecord(m) ? m.id : m))
      );
      missing = ocModels.filter((m) => !kept.has(m.id));
    } else {
      const stub = structuredClone(ocProvider);
      delete stub.apiKey;
      stub.models = [];
      entries.set(key, stub);
    }
    for (const model of missing) additions.push([key, model]);
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
 * clears OpenClaw's 50% rule, otherwise the next provider-catalog step. Null
 * when no step can explain the shrink.
 */
export function planShrinkPush({
  target,
  ocConfig,
  ocBaselineBytes,
  offset,
}: ShrinkPushState): { payload: string; isStep: boolean } | null {
  const floorHalf = Math.floor(ocBaselineBytes * 0.5);
  if (
    ocBaselineBytes < OPENCLAW_SIZE_DROP_MIN_BASELINE_BYTES ||
    utf8Bytes(target) + offset >= floorHalf
  ) {
    return { payload: target, isStep: false };
  }
  if (!ocConfig) return null;
  const step = buildProviderShrinkStep(
    JSON.parse(target) as Json,
    ocConfig,
    floorHalf + SIZE_DROP_MARGIN_BYTES - offset
  );
  return step ? { payload: serialize(step), isStep: true } : null;
}
