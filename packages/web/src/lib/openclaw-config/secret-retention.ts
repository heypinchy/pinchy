// When a secret may leave secrets.json: once OpenClaw no longer needs it.
//
// regenerateOpenClawConfig writes secrets.json BEFORE it pushes the config it
// built. For an ordinary change that window is a round trip. For a provider
// deletion it is a stepped hand-over at OpenClaw's rate limit (size-drop.ts),
// minutes long, and it can be superseded, dropped and resumed. For that whole
// window OpenClaw's openclaw.json — on disk, and so what it runs and what it
// loads on a restart — still points at the deleted provider's key. Taking the
// key out first broke both:
//
//   - every `config.apply` of a config still naming it is refused
//     (`active SecretRef resolution failed`), which is precisely what a
//     targeted writer sends: it reads that file and changes one block;
//   - an OpenClaw restart (the secrets tmpfs volume survives one) fails at
//     startup with "required secrets are unavailable", and nothing recovers.
//
// The rule: a secret the NEXT config stops referencing is RETAINED while the
// on-disk openclaw.json still references it, and RELEASED as soon as a config
// that does not reference it has reached OpenClaw (a push delivered it). The
// next regenerate re-derives the same answer from the file, so a key never
// outlives OpenClaw's own reference to it by more than one regenerate.
//
// Only removals are retained. A value the next bundle carries always wins (a
// rotation is never undone), and a key the next config still references but
// the bundle lacks is NOT papered over with the old value — that is a real
// misconfiguration, and OpenClaw's refusal is the honest signal for it.
import { readSecretsFile, writeSecretsFile, type SecretsBundle } from "@/lib/openclaw-secrets";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `{ source: "file", provider: "pinchy", id }` SecretRefs Pinchy emits. */
function isPinchySecretRef(value: unknown): value is { id: string } {
  return (
    isRecord(value) &&
    value.source === "file" &&
    value.provider === "pinchy" &&
    typeof value.id === "string"
  );
}

/** Every pinchy SecretRef id (a JSON pointer into secrets.json) anywhere in a config. */
export function pinchySecretRefIds(config: unknown, out = new Set<string>()): Set<string> {
  if (isPinchySecretRef(config)) {
    out.add(config.id);
    return out;
  }
  if (Array.isArray(config)) {
    for (const item of config) pinchySecretRefIds(item, out);
  } else if (isRecord(config)) {
    for (const child of Object.values(config)) pinchySecretRefIds(child, out);
  }
  return out;
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * RFC 6901 pointer → segments. Null for anything that is not an absolute
 * pointer, or that names a prototype key: the ids come from a file on a shared
 * volume, and a retained value is written back along this path.
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

function setAt(root: Json, segments: string[], value: string): void {
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (!isRecord(child)) node[segment] = {};
    node = node[segment] as Json;
  }
  node[segments[segments.length - 1]] = value;
}

/** Delete the leaf, then every parent the deletion left empty. */
function deleteAt(root: Json, segments: string[]): void {
  const parents: Json[] = [root];
  let node: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(node)) return;
    node = node[segment];
    if (!isRecord(node)) return;
    parents.push(node);
  }
  delete parents[parents.length - 1][segments[segments.length - 1]];
  for (let depth = segments.length - 1; depth > 0; depth--) {
    if (Object.keys(parents[depth]).length > 0) break;
    delete parents[depth - 1][segments[depth - 1]];
  }
}

/** Secret pointer id → the value retained for it. */
export type RetainedSecrets = Map<string, string>;

/**
 * The bundle to write for `next`: `next` plus every value `previous` held for a
 * SecretRef that the on-disk config still references and `nextConfig` no
 * longer does. `next` itself is never mutated.
 */
export function retainSecretsStillReferenced({
  next,
  previous,
  onDiskConfig,
  nextConfig,
}: {
  next: SecretsBundle;
  previous: SecretsBundle;
  onDiskConfig: unknown;
  nextConfig: unknown;
}): { bundle: SecretsBundle; retained: RetainedSecrets } {
  const retained: RetainedSecrets = new Map();
  const stillWanted = pinchySecretRefIds(nextConfig);
  let bundle: Json | undefined;
  for (const id of pinchySecretRefIds(onDiskConfig)) {
    if (stillWanted.has(id)) continue;
    const segments = pointerSegments(id);
    if (!segments || getAt(next, segments) !== undefined) continue;
    const value = getAt(previous, segments);
    if (typeof value !== "string") continue;
    bundle ??= structuredClone(next) as Json;
    setAt(bundle, segments, value);
    retained.set(id, value);
  }
  return { bundle: (bundle as SecretsBundle | undefined) ?? next, retained };
}

/** The pinchy SecretRef ids in `config` that `bundle` cannot resolve to a string. */
export function unresolvedSecretRefs(config: unknown, bundle: SecretsBundle): string[] {
  return [...pinchySecretRefIds(config)].filter((id) => {
    const segments = pointerSegments(id);
    return !segments || typeof getAt(bundle, segments) !== "string";
  });
}

// Process-wide, on globalThis like push-state.ts: this module is loaded twice in
// one Pinchy process (the custom server via tsx, and Next's route bundles), and
// the regenerate that retains and the push that releases can sit in either.
declare global {
  var __pinchyRetainedSecrets: RetainedSecrets | undefined;
}

function retainedState(): RetainedSecrets {
  globalThis.__pinchyRetainedSecrets ??= new Map();
  return globalThis.__pinchyRetainedSecrets;
}

/** Record what the latest regenerate retained (replaces the previous record). */
export function setRetainedSecrets(retained: RetainedSecrets): void {
  globalThis.__pinchyRetainedSecrets = new Map(retained);
}

/**
 * A config has reached OpenClaw (applied, or written to its file). Remove every
 * retained secret it no longer references from secrets.json — but only where
 * secrets.json still holds the value that was retained: a provider re-added
 * with a new key since is not ours to remove.
 *
 * Best-effort and never throws: a failure here leaves the key in place for the
 * next regenerate to drop, which is the state before this release ran.
 */
export function releaseRetainedSecrets(deliveredContent: string): void {
  const retained = retainedState();
  if (retained.size === 0) return;
  try {
    const stillReferenced = pinchySecretRefIds(JSON.parse(deliveredContent));
    const released = [...retained].filter(([id]) => !stillReferenced.has(id));
    if (released.length === 0) return;
    const current = readSecretsFile() as Json;
    let changed = false;
    for (const [id, value] of released) {
      retained.delete(id);
      const segments = pointerSegments(id);
      if (segments && getAt(current, segments) === value) {
        deleteAt(current, segments);
        changed = true;
      }
    }
    if (!changed) return;
    // A pure removal: writeSecretsFile reports no new value, so no
    // secrets.reload — OpenClaw already runs a config without the reference.
    writeSecretsFile(current as SecretsBundle);
    console.log(
      `[openclaw-config] released ${String(released.length)} secret(s) OpenClaw no longer references: ${released.map(([id]) => id).join(", ")}`
    );
  } catch (err) {
    console.warn(
      "[openclaw-config] could not release retained secrets (the next regenerate drops them):",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Test-only: forget every retained secret. Do not call in app code. */
export function _resetRetainedSecrets(): void {
  globalThis.__pinchyRetainedSecrets = new Map();
}
