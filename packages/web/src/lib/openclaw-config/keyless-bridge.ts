// openclaw.json stops naming a key before secrets.json loses it.
//
// regenerateOpenClawConfig writes secrets.json from the database, so a deleted
// provider's key leaves the bundle at once. OpenClaw's openclaw.json keeps
// naming that key until the push delivers the deletion — for a large provider a
// stepped hand-over at OpenClaw's rate limit (size-drop.ts), minutes long, that
// can be dropped and resumed; and for an install that hit this before it was
// fixed, forever. Every reader of the file in that window needs its SecretRefs
// to resolve:
//
//   - OpenClaw itself, when it (re)starts: an unresolvable one fails startup
//     with "required secrets are unavailable", and nothing recovers that;
//   - every config.apply of a copy of it — a targeted writer
//     (updateTelegramChannelConfig) reads the file and changes one block, and
//     OpenClaw refuses it with `active SecretRef resolution failed`.
//
// So before a secrets.json without the key is written, Pinchy writes the
// on-disk file with every provider that names a key the new bundle lacks
// replaced by its key-less stub, keeping its models: the "bridge". Its
// SecretRefs all resolve against the old secrets.json and the new one alike,
// so there is no order in which a reader can catch it unresolvable. The
// stepped hand-over then continues from it (the steps re-add from OpenClaw's
// file, so they are key-less too).
//
// A provider can also name a key the bundle lacks while staying in the target:
// an OpenAI-compatible provider that was re-keyed. Its key lives in a
// versioned slot (`providers.<slug>@<version>`, see versionedSecretName), so a
// new key is a new slot and the old one leaves the bundle. Stubbing it until
// the push lands would leave every agent on it without a key, so once
// secrets.json holds the new slot, a second write gives it the TARGET's entry
// (rekeyedBridge) — the base URL, the slot and the models of one saved state of
// the provider, so the new key never meets the old address. Two writes, because
// no single order works with one: the old slot is in the old secrets.json only,
// the new slot in the new one only, and the key-less stub in between resolves
// against both.
//
// The decision needs only openclaw.json (0666) and the bundle Pinchy just
// built — never secrets.json, which Pinchy cannot read in production
// (fix-config-permissions.sh chowns it to root:root 0600 every 50 ms). Earlier
// designs kept the old key in secrets.json instead, while the file still named
// it; they read the old value from that file, so in production they silently
// retained nothing.
//
// What OpenClaw (2026.7.1) does with the bridge, verified against its code
// (integration/openclaw-config-size-drop-against-oc.test.ts):
//
//   - it is an ordinary external edit: the reloader's watcher picks it up,
//     `models.*` is hot-reloadable (restart-heartbeat only, no gateway
//     restart), it re-resolves the config's SecretRefs — all resolvable — and
//     promotes it to last-known-good;
//   - only key references and credentials leave, so it stays far above half
//     of the file it replaces: neither OpenClaw's write-side size check nor
//     its read-side recovery (restore last-known-good / `.bak` under 50%)
//     objects, and its startup read keeps it;
//   - the stubbed provider keeps its models, so nothing that still names one
//     becomes an "Unknown model" before the deletion lands.
import { providerStub } from "./size-drop";
import { referencedSecretIds, type SecretsBundle } from "@/lib/openclaw-secrets";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * RFC 6901 pointer → segments. Null for anything that is not an absolute
 * pointer, or that names a prototype key: the ids come from a file on a shared
 * volume.
 */
function pointerSegments(id: string): string[] | null {
  if (!id.startsWith("/")) return null;
  const segments = id
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return segments.some((s) => s === "" || FORBIDDEN_SEGMENTS.has(s)) ? null : segments;
}

function getAt(root: unknown, segments: string[]): unknown {
  let node: unknown = root;
  for (const segment of segments) {
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/** The pinchy SecretRef ids in `config` that `bundle` cannot resolve to a string. */
export function unresolvedSecretRefs(config: unknown, bundle: SecretsBundle): string[] {
  return [...referencedSecretIds(config)].filter((id) => {
    const segments = pointerSegments(id);
    return !segments || typeof getAt(bundle, segments) !== "string";
  });
}

/**
 * The file to write before `bundle` replaces secrets.json: `onDisk` with every
 * provider that names a SecretRef `bundle` cannot resolve replaced by its
 * key-less stub (inert baseUrl, api, all its models — see providerStub).
 * Null when every SecretRef in `onDisk` resolves: nothing to bridge.
 *
 * Pinchy emits SecretRefs only at `models.providers.*.apiKey`; a dangling one
 * anywhere else is reported by regenerateOpenClawConfig, not bridged.
 */
export function keylessBridge(onDisk: Json, bundle: SecretsBundle): Json | null {
  if (unresolvedSecretRefs(onDisk, bundle).length === 0) return null;
  const models = isRecord(onDisk.models) ? onDisk.models : {};
  const providers = isRecord(models.providers) ? models.providers : {};
  const bridged = Object.fromEntries(
    Object.entries(providers).map(([key, provider]) =>
      isRecord(provider) && unresolvedSecretRefs(provider, bundle).length > 0
        ? [key, { ...providerStub(provider), models: provider.models ?? [] }]
        : [key, provider]
    )
  );
  return { ...onDisk, models: { ...models, providers: bridged } };
}

/**
 * The file to write AFTER `bundle` replaced secrets.json: `keyless` (from
 * {@link keylessBridge}) with every provider it stubbed that `target` still has
 * given `target`'s entry for it — when every SecretRef in that entry resolves
 * against `bundle`. That is a re-keyed provider (a new versioned key slot), or
 * one upgraded from an unversioned slot. The whole entry, not just the
 * SecretRef: the key was entered for the target's base URL, and must not be
 * paired with the one on disk. Null when no provider qualifies: a deleted one
 * stays a stub until the push removes it.
 */
export function rekeyedBridge(
  keyless: Json,
  onDisk: Json,
  target: Json,
  bundle: SecretsBundle
): Json | null {
  const providersOf = (config: Json): Json => {
    const models = isRecord(config.models) ? config.models : {};
    return isRecord(models.providers) ? models.providers : {};
  };
  const onDiskProviders = providersOf(onDisk);
  const targetProviders = providersOf(target);
  const rekeyed = Object.keys(providersOf(keyless)).filter((key) => {
    const was = onDiskProviders[key];
    const next = targetProviders[key];
    return (
      isRecord(was) &&
      unresolvedSecretRefs(was, bundle).length > 0 &&
      isRecord(next) &&
      unresolvedSecretRefs(next, bundle).length === 0
    );
  });
  if (rekeyed.length === 0) return null;
  const models = isRecord(keyless.models) ? keyless.models : {};
  const providers = { ...providersOf(keyless) };
  for (const key of rekeyed) providers[key] = targetProviders[key];
  return { ...keyless, models: { ...models, providers } };
}
