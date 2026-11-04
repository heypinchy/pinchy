import {
  writeFileSync,
  readFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  chmodSync,
  accessSync,
  constants,
} from "fs";
import { dirname } from "path";
import { createHash } from "crypto";

export type SecretRef = {
  source: "file";
  provider: "pinchy";
  id: string;
};

export function secretRef(id: string): SecretRef {
  return { source: "file", provider: "pinchy", id };
}

const DEFAULT_SECRETS_PATH = "/openclaw-secrets/secrets.json";

/**
 * A short, stable fingerprint of a secret's stored form, for naming a versioned
 * slot. Feed it the CIPHERTEXT, never the plaintext: AES-GCM with a random IV
 * makes the ciphertext new on every save — even when the same key is typed
 * again — and a hash of it says nothing about the key, while a hash of a weak
 * plaintext key would be a dictionary lookup away in openclaw.json.
 */
export function secretVersion(ciphertext: string): string {
  return createHash("sha256").update(ciphertext).digest("hex").slice(0, 16);
}

/**
 * The bundle slot for a versioned secret: `<name>@<version>`.
 *
 * Why version a slot at all: OpenClaw resolves a config-tree SecretRef when a
 * config is applied, and it keeps the runtime it resolved until the next
 * successful apply or `secrets.reload`. If the pointer stayed the same while
 * both the key and the address it is sent to changed, the two halves would
 * reach the runtime by different routes — the address by config apply, the
 * key by a separate reload that can fail or race it — and for a while the new
 * key could go to the old address (or the old key to the new one). With the
 * version in the name, a new key IS a new pointer: the only config that can
 * resolve it is the one carrying the address it was entered for, and a config
 * still pointing at the previous version finds nothing and fails closed
 * (OpenClaw stays on its last-known-good snapshot).
 */
export function versionedSecretName(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Every id a config points at through a Pinchy file SecretRef
 * (`/providers/acme-llm@0123456789abcdef/apiKey`, …), wherever in the tree the
 * ref sits. Walking the tree rather than naming branches keeps this right when
 * a new section starts using SecretRefs.
 */
export function referencedSecretIds(config: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(config)) {
    for (const item of config) referencedSecretIds(item, out);
  } else if (config !== null && typeof config === "object") {
    const node = config as Record<string, unknown>;
    if (node.source === "file" && node.provider === "pinchy" && typeof node.id === "string") {
      out.add(node.id);
    } else {
      for (const child of Object.values(node)) referencedSecretIds(child, out);
    }
  }
  return out;
}

/** A path segment written by {@link versionedSecretName}. */
const VERSIONED_SEGMENT = /^[^@/]+@[0-9a-f]{16}$/;

export type SecretsBundle = {
  gateway?: { token?: string };
  providers?: Record<string, { apiKey: string }>;
  integrations?: Record<string, Record<string, string>>;
  telegram?: Record<string, { botToken: string }>;
  /**
   * Per-plugin shared secrets. Pinchy generates and persists each entry in the
   * settings DB and materialises it here so OC-side plugins can read it from
   * the shared `/openclaw-secrets/secrets.json` file at runtime. Use for
   * symmetric keys / HMAC secrets that need to be the same in pinchy-web and
   * a pinchy-* plugin (e.g. `pinchy-odoo` integration-ref encryption).
   */
  plugins?: Record<string, Record<string, string>>;
};

/**
 * Actionable message for the #878 failure: the `openclaw-secrets` volume that
 * this Pinchy version requires is not mounted, so the secrets directory cannot
 * be created or written. The bare `EACCES: permission denied, mkdir
 * '/openclaw-secrets'` that Node throws is useless to a self-hoster — it gives
 * no hint that the cause is a stale `docker-compose.yml` left behind by an
 * image-only upgrade (`docker compose pull` never re-fetches the compose file).
 */
function secretsVolumeErrorMessage(dir: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    `[openclaw-config] Cannot create or write the OpenClaw secrets directory at ${dir}. ` +
    `Pinchy stores provider API keys and other runtime secrets here, so OpenClaw config ` +
    `generation cannot proceed.\n\n` +
    `The most likely cause: your docker-compose.yml is missing the \`openclaw-secrets\` ` +
    `volume mount that this Pinchy version requires. An image-only upgrade ` +
    `(\`docker compose pull\`) does NOT update docker-compose.yml — re-fetch the compose ` +
    `file for your release, then run \`docker compose up -d\` again.\n\n` +
    `See https://docs.heypinchy.com/guides/upgrading/ for the upgrade steps.\n\n` +
    `Underlying error: ${detail}`
  );
}

/**
 * Boot/preflight check: verify the secrets directory can be created and is
 * writable, WITHOUT writing any content. Returns an actionable message instead
 * of throwing so callers (e.g. bootInits) can surface the problem loudly and
 * early — before a deep `writeSecretsFile` EACCES aborts `regenerateOpenClawConfig`
 * and freezes the whole instance (#878).
 */
export function checkSecretsVolumeWritable(): { ok: true } | { ok: false; message: string } {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  const dir = dirname(path);
  try {
    // `recursive: true` is a no-op when `dir` already exists as a directory
    // (the correctly-mounted case) and throws otherwise — EACCES when the
    // parent isn't writable (missing mount), EEXIST/ENOTDIR when a non-dir
    // sits in the path. Any of those means we can't write secrets here.
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: secretsVolumeErrorMessage(dir, err) };
  }
}

/**
 * Every secret value in a bundle, keyed by its path through the nested shape
 * (`providers/anthropic/apiKey`, `plugins/pinchy-odoo/refTokenKey`, …). Walking
 * the tree rather than naming branches keeps this correct when the bundle grows
 * a section — a missed branch would silently stop reporting rotations in it.
 */
function flattenSecretValues(
  value: unknown,
  prefix = "",
  out = new Map<string, string>()
): Map<string, string> {
  if (typeof value === "string") {
    out.set(prefix, value);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenSecretValues(child, prefix ? `${prefix}/${key}` : key, out);
    }
  }
  return out;
}

/** Parse the previous file; an unreadable one counts as empty. */
function parsePreviousBundle(previousContent: string | undefined): unknown {
  if (previousContent === undefined) return {};
  try {
    return JSON.parse(previousContent);
  } catch {
    // Unreadable/corrupt previous state — treat every value as new, which is
    // the safe side: an unnecessary reload costs a round trip, a missed one
    // costs every agent a 401.
    return {};
  }
}

/**
 * True when `next` holds a value the previous bundle did not have under the
 * same path — added or rotated. Deliberately false when the only difference is
 * that values DISAPPEARED (see the removal note on {@link writeSecretsFile}),
 * and for versioned slots (see {@link versionedSecretName}).
 */
function hasNewOrRotatedValue(previousBundle: unknown, next: SecretsBundle): boolean {
  const before = flattenSecretValues(previousBundle);
  for (const [path, value] of flattenSecretValues(next)) {
    // A versioned slot never needs a reload: its value cannot change in place,
    // and a new slot is reachable only through the config that names it — the
    // config apply of this same regenerate. See versionedSecretName.
    if (path.split("/").some((segment) => VERSIONED_SEGMENT.test(segment))) continue;
    if (before.get(path) !== value) return true;
  }
  return false;
}

/**
 * Writes the secrets bundle and reports whether the running OpenClaw is now
 * holding a stale credential.
 *
 * The return value is load-bearing, not a convenience: a rotation on an
 * already-configured built-in provider (or any other unversioned slot) changes
 * THIS FILE AND NOTHING ELSE. The emitted `openclaw.json` carries a SecretRef,
 * not the value, so it stays byte-identical and every config-level change
 * detector correctly concludes "no change" — after which nothing tells the
 * running OpenClaw that the credential it resolved is now stale (#943). Callers
 * use this flag to push a `secrets.reload` that no config diff would ever
 * trigger.
 *
 * An OpenAI-compatible provider is the exception, on purpose. Its key lives in
 * a versioned slot (`providers.<slug>@<keyVersion>`, see versionedSecretName),
 * so a rotation DOES change `openclaw.json` — the SecretRef names the new slot —
 * and the new key reaches OpenClaw with that config apply. A versioned slot
 * therefore never sets this flag (see hasNewOrRotatedValue): a reload would
 * re-resolve the config OpenClaw is still running, which points at the old
 * slot, and must not be the route by which a key meets an address.
 *
 * A pure REMOVAL returns false even though the file did change. A reload
 * re-resolves the config OpenClaw is currently running; a removal gives it
 * nothing new to resolve, and the removal itself travels with the config apply
 * of the same regenerate. A removed value is gone from this file at once — the
 * bundle is written exactly as given. Before a value the on-disk openclaw.json
 * still names is removed, regenerate rewrites that file so it no longer names
 * it (openclaw-config/keyless-bridge.ts); this function keeps nothing back,
 * because keeping a value would mean reading it from this file.
 *
 * The previous file is read only to decide the return value and to skip an
 * identical write, never for what is written. In production it is unreadable
 * to Pinchy (fix-config-permissions.sh chowns it to root:root 0600 every
 * 50 ms); it then counts as empty, so every unversioned value counts as new
 * and a reload is requested — the safe side: an unnecessary reload costs a
 * round trip, a missed one costs every agent a 401.
 */
export function writeSecretsFile(bundle: SecretsBundle): boolean {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;

  let previousContent: string | undefined;
  if (existsSync(path)) {
    try {
      previousContent = readFileSync(path, "utf-8");
    } catch {
      // Fall through and write — if read failed for any reason, a write attempt
      // is the safer recovery path than silently leaving stale content.
      previousContent = undefined;
    }
  }
  const previousBundle = parsePreviousBundle(previousContent);
  const newContent = JSON.stringify(bundle, null, 2);

  // Skip the write when content is unchanged to avoid a spurious inotify event
  // that would trigger OpenClaw's secrets-file watcher unnecessarily.
  if (previousContent === newContent) return false;
  const runtimeIsStale = hasNewOrRotatedValue(previousBundle, bundle);

  const dir = dirname(path);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    // Mode 0600: owner-only read/write. The tmpfs directory mode (0770) already
    // restricts access to uid 999 (the pinchy user), but file-level 0600 is
    // cheap defense-in-depth against same-uid local processes (e.g. shells
    // inside docker exec).
    writeFileSync(tmp, newContent, { mode: 0o600 });
    chmodSync(tmp, 0o600); // enforce regardless of umask
    renameSync(tmp, path);
    return runtimeIsStale;
  } catch (err) {
    // Replace the bare EACCES/ENOTDIR with an actionable message. This is the
    // single choke point every regenerateOpenClawConfig() flows through, so both
    // boot (bootInits catch) and every state-changing API route surface the same
    // guidance instead of a stack trace buried in logs (#878).
    throw new Error(secretsVolumeErrorMessage(dir, err));
  }
}

/**
 * Whether secrets.json is there at all. Pinchy cannot read it in production,
 * but it can see it: the directory is Pinchy's (0770, uid 999). Gone after a
 * host reboot — the volume is a tmpfs.
 */
export function secretsFileExists(): boolean {
  return existsSync(process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH);
}

export function readSecretsFile(): SecretsBundle {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}
