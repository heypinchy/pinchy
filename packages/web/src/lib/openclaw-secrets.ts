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

export type SecretRef = {
  source: "file";
  provider: "pinchy";
  id: string;
};

export function secretRef(id: string): SecretRef {
  return { source: "file", provider: "pinchy", id };
}

const DEFAULT_SECRETS_PATH = "/openclaw-secrets/secrets.json";

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

/**
 * True when `next` holds a value the previous bundle did not have under the
 * same path — added or rotated. Deliberately false when the only difference is
 * that values DISAPPEARED: see the removal note on {@link writeSecretsFile}.
 */
function hasNewOrRotatedValue(previousContent: string | undefined, next: SecretsBundle): boolean {
  let previousBundle: unknown = {};
  if (previousContent !== undefined) {
    try {
      previousBundle = JSON.parse(previousContent);
    } catch {
      // Unreadable/corrupt previous state — treat every value as new, which is
      // the safe side: an unnecessary reload costs a round trip, a missed one
      // costs every agent a 401.
      previousBundle = {};
    }
  }
  const before = flattenSecretValues(previousBundle);
  for (const [path, value] of flattenSecretValues(next)) {
    if (before.get(path) !== value) return true;
  }
  return false;
}

/**
 * Writes the secrets bundle and reports whether the running OpenClaw is now
 * holding a stale credential.
 *
 * The return value is load-bearing, not a convenience: a rotation on an
 * already-configured provider changes THIS FILE AND NOTHING ELSE. The emitted
 * `openclaw.json` carries a SecretRef, not the value, so it stays byte-identical
 * and every config-level change detector correctly concludes "no change" — after
 * which nothing tells the running OpenClaw that the credential it resolved at
 * process start is now stale (#943). Callers use this flag to push a
 * `secrets.reload` that no config diff would ever trigger.
 *
 * A pure REMOVAL returns false even though the file did change. OpenClaw
 * re-resolves the config it is currently running, and that config still points
 * at the key just taken away — so a reload there fails on the dangling pointer,
 * degrades OpenClaw's secrets runtime, and prints "restart the gateway" for a
 * deletion that the config apply from this same regenerate already repairs. The
 * removal travels with that config change and needs no reload of its own.
 */
export function writeSecretsFile(bundle: SecretsBundle): boolean {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  const newContent = JSON.stringify(bundle, null, 2);

  // Skip the write when content is unchanged to avoid a spurious inotify event
  // that would trigger OpenClaw's secrets-file watcher unnecessarily.
  let previousContent: string | undefined;
  if (existsSync(path)) {
    try {
      previousContent = readFileSync(path, "utf-8");
      if (previousContent === newContent) return false;
    } catch {
      // Fall through and write — if read failed for any reason, a write attempt
      // is the safer recovery path than silently leaving stale content.
      previousContent = undefined;
    }
  }
  const runtimeIsStale = hasNewOrRotatedValue(previousContent, bundle);

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

export function readSecretsFile(): SecretsBundle {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}
