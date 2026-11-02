import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import {
  readFileSync,
  existsSync,
  openSync,
  fstatSync,
  closeSync,
  writeSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { basename, dirname, join } from "path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/** Where a file-backed secret currently comes from (issue #156). */
export type SecretSource = "envvar" | "file" | "unset";

function secretPaths(name: string) {
  const keyFileDir = process.env.ENCRYPTION_KEY_DIR || "/app/secrets";
  return { keyFileDir, keyFilePath: join(keyFileDir, `.${name}`) };
}

/**
 * getOrCreateSecret is called on every audit append (audit_hmac_secret) and
 * every encrypt/decrypt (encryption_key) — a synchronous file read on every
 * one of those, holding up an advisory-locked transaction in the audit case.
 * Cache the parsed Buffer per key-file path, invalidated by the file's mtime
 * rather than never: a rotated secret (new content, new mtime) is picked up
 * on the next call with no restart, while an unchanged file costs only a
 * cheap statSync instead of a read + hex-validate on every call.
 */
const fileSecretCache = new Map<string, { mtimeMs: number; secret: Buffer }>();

/**
 * Resolve the provenance of a secret WITHOUT creating it. Mirrors the
 * priority order of getOrCreateSecret below — keep both in sync by having
 * getOrCreateSecret dispatch on this function.
 */
export function getSecretSource(name: string): SecretSource {
  const envKey = process.env[name.toUpperCase()];
  if (envKey && envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    return "envvar";
  }
  if (existsSync(secretPaths(name).keyFilePath)) {
    return "file";
  }
  return "unset";
}

/**
 * Read a secret file, cached by mtime.
 *
 * stat and read through the SAME descriptor: a path-based stat followed by a
 * path-based read is a TOCTOU race (CodeQL js/file-system-race) — the file
 * could be replaced between the two calls, and the cache would then pair the
 * old file's mtime with the new file's bytes and never notice the rotation.
 *
 * Throws if the file is missing or does not hold 64 hex characters.
 */
function readSecretFile(keyFilePath: string): Buffer {
  const fd = openSync(keyFilePath, "r");
  try {
    const mtimeMs = fstatSync(fd).mtimeMs;
    const cached = fileSecretCache.get(keyFilePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.secret;
    }

    const fileKey = readFileSync(fd, "utf-8").trim();
    if (fileKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(fileKey)) {
      throw new Error(`Invalid secret in ${keyFilePath}: expected 64 hex characters`);
    }
    const secret = Buffer.from(fileKey, "hex");
    fileSecretCache.set(keyFilePath, { mtimeMs, secret });
    return secret;
  } finally {
    closeSync(fd);
  }
}

/**
 * The secret this one superseded, when that is knowable — otherwise null.
 *
 * Pinning `AUDIT_HMAC_SECRET` in `.env` on an install that has been running on
 * the auto-generated file secret leaves a log signed under two keys. The env
 * var wins from that restart on, but the superseded key is still sitting in the
 * `pinchy-secrets` volume, and nothing used to look at it: `verifyIntegrity`
 * recomputed every older row under the NEW key and reported all of them as
 * tampered. Accusing the log of tampering because the operator did what the
 * docs told them to is worse than saying nothing at all.
 *
 * So: when the env var is what's active and a DIFFERENT valid secret file still
 * exists, that file is the previous key. Rows are verified against it as a
 * fallback and reported in their own bucket — never merged into "valid and
 * current", so the rotation stays visible to whoever is reading the report.
 *
 * This does not weaken tamper-evidence. The file is root-owned inside the
 * secrets volume; an attacker who can write it can already write the database
 * and drop the append-only triggers, which is exactly where
 * `audit-trail-verification.mdx` already draws the threat-model line.
 *
 * The limitation is real and documented: this covers env-over-file. An operator
 * who OVERWRITES the file has destroyed the old key, and nothing can bring back
 * the ability to verify rows signed under it. An install that only ever had the
 * variable gets the file from persistEnvSecretToKeyFile at startup, so its old
 * value is here too when the variable changes.
 */
export function getPreviousSecret(name: string): Buffer | null {
  if (getSecretSource(name) !== "envvar") return null;

  const { keyFilePath } = secretPaths(name);
  if (!existsSync(keyFilePath)) return null;

  let fileSecret: Buffer;
  try {
    fileSecret = readSecretFile(keyFilePath);
  } catch {
    // A corrupt leftover file is not a previous key we can verify against, and
    // must never take down verification. Absence is the honest answer.
    return null;
  }

  const active = Buffer.from(process.env[name.toUpperCase()]!, "hex");
  // Same value on both paths: nothing was superseded, so there is no previous
  // key and no rotation to report.
  return fileSecret.equals(active) ? null : fileSecret;
}

/** What {@link persistEnvSecretToKeyFile} did. Never carries the key. */
export type EnvSecretPersistOutcome =
  /** `dir` is the key directory the file went to (ENCRYPTION_KEY_DIR). */
  | { status: "written"; dir: string }
  | { status: "file-exists" }
  | { status: "file-invalid" }
  | { status: "file-unreadable"; code: string }
  | { status: "not-envvar" }
  | { status: "failed"; reason: string };

/**
 * What `link` fails with on a volume that has no hard links: exFAT and vfat
 * (ENOTSUP on macOS, EPERM on Linux), and some FUSE and SMB mounts (ENOSYS,
 * EOPNOTSUPP, or EXDEV from a mount that maps each file to its own device).
 * EPERM is otherwise what Linux's protected_hardlinks returns for a file the
 * caller does not own, which cannot happen here: the temp file is our own.
 */
const NO_HARD_LINK_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS", "EXDEV"]);

/**
 * Write all of `data`, then fsync. `write` may return having written only part
 * of the buffer; ignoring the count would leave a key file holding the first
 * few characters of a key the process is already using in full. A write that
 * makes no progress at all is an error, never a loop.
 */
function writeAllAndSync(fd: number, path: string, data: string): void {
  const bytes = Buffer.from(data);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!(written > 0)) {
      throw Object.assign(new Error(`EIO: write made no progress, write '${path}'`), {
        code: "EIO",
      });
    }
    offset += written;
  }
  fsyncSync(fd);
}

/**
 * Make a new name in `dir` durable. The file's own fsync covers its bytes,
 * not the directory entry: until the directory is fsynced, a power cut can
 * lose the key file while the process has already used the key it holds.
 *
 * Best effort, and only ever called once the key file already has its name.
 * Any error here (EACCES on a directory the process may write but not read,
 * EISDIR/EINVAL/EPERM/ENOTSUP/ENOSYS on Windows and some FUSE, SMB and NFS
 * mounts) leaves the key file in place and readable; reporting it as a failed
 * write would throw away a key that is already on disk. A plain
 * writeFileSync, which this replaced, never fsynced the directory either.
 */
function fsyncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // See above: the name is already there, only its durability is not.
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing to recover; the descriptor is gone either way.
    }
  }
}

/**
 * Write a key to its key file without ever leaving a partial file or replacing
 * an existing one: written and fsynced to a temporary file in the same
 * directory, then hard-linked to the final name. `link` fails with EEXIST
 * instead of replacing, so a file that appeared in between (another process,
 * another instance on a shared volume) is never touched, and a full disk or a
 * crash mid-write leaves at most a temp file, never a 0-byte key file that
 * every later read would trip over.
 *
 * A volume without hard links (see {@link NO_HARD_LINK_CODES}) gets
 * {@link createKeyFileDirectly} instead: still never replacing, and still no
 * partial file on a failed write, but a crash mid-write there can leave one.
 * Before the link, a plain write worked on such a volume, so the stricter
 * write must not be what stops Pinchy from starting there.
 *
 * Returns "exists" when another file got there first. Throws on any other
 * error; fs errors name the code and the path, never the content.
 */
function writeKeyFileExclusive(keyFilePath: string, keyHex: string): "written" | "exists" {
  const tmpPath = `${keyFilePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    try {
      writeAllAndSync(fd, tmpPath, keyHex);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmpPath, keyFilePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return "exists";
      if (code && NO_HARD_LINK_CODES.has(code)) return createKeyFileDirectly(keyFilePath, keyHex);
      throw err;
    }
    fsyncDirectory(dirname(keyFilePath));
    return "written";
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Left for removeStaleKeyTempFiles on the next start.
    }
  }
}

/**
 * The fallback for a volume without hard links: create the key file itself,
 * exclusively ("wx" fails with EEXIST instead of replacing), then write and
 * fsync. A failed write removes the file it just created, which is ours
 * because the exclusive create succeeded, so a full disk still leaves no empty
 * key file behind.
 */
function createKeyFileDirectly(keyFilePath: string, keyHex: string): "written" | "exists" {
  let fd: number;
  try {
    fd = openSync(keyFilePath, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw err;
  }
  try {
    try {
      writeAllAndSync(fd, keyFilePath, keyHex);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    try {
      unlinkSync(keyFilePath);
    } catch {
      // Nothing more to do; the write error below is the one worth reporting.
    }
    throw err;
  }
  fsyncDirectory(dirname(keyFilePath));
  return "written";
}

// `<pid>.<8 hex>`, the middle of the temp names writeKeyFileExclusive creates.
const TEMP_SUFFIX = /^\d+\.[0-9a-f]{8}$/;

/**
 * Remove the temp files a crash between writing and unlinking left next to a
 * key file. Each one holds a copy of the key, and nothing else would ever
 * clean it up. Only names of exactly the form writeKeyFileExclusive creates,
 * only in the key file's own directory.
 *
 * Called by {@link persistEnvSecretToKeyFile} at startup, and by
 * {@link getOrCreateSecret} the first time a process uses each key file, so
 * the temp files of every key it generates are cleaned up, the encryption key
 * included, not only the audit key startup persists. An instance writing a key
 * at that very moment on a shared volume could lose its in-flight temp file to
 * this; its write then fails and is reported, and the other instance's write
 * still lands.
 */
function removeStaleKeyTempFiles(keyFilePath: string): void {
  const dir = dirname(keyFilePath);
  const prefix = `${basename(keyFilePath)}.`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // No directory, nothing to clean; the write reports the real problem.
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
    if (!TEMP_SUFFIX.test(entry.slice(prefix.length, -".tmp".length))) continue;
    try {
      unlinkSync(join(dir, entry));
    } catch {
      // Best effort: a file we cannot remove is no worse than before.
    }
  }
}

/**
 * Key files getOrCreateSecret has already looked for stale temp files next
 * to, in this process. It sits on the hot path of every encrypt, decrypt and
 * audit append, and only a crash leaves those files, so once is enough.
 */
const keyFilesCleaned = new Set<string>();

function removeStaleKeyTempFilesOnce(keyFilePath: string): void {
  if (keyFilesCleaned.has(keyFilePath)) return;
  keyFilesCleaned.add(keyFilePath);
  removeStaleKeyTempFiles(keyFilePath);
}

/**
 * An existing key file: a key we can read, a file that is not a key, or one
 * we cannot read at all. The last two are different problems with different
 * fixes. A file we cannot read (a root-owned restore, a directory in its
 * place) may hold exactly the earlier key that verifies what it signed;
 * calling it invalid would send the operator to move a good key aside.
 */
function existingKeyFileOutcome(keyFilePath: string): EnvSecretPersistOutcome {
  try {
    readSecretFile(keyFilePath);
    return { status: "file-exists" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // readSecretFile's format error carries no code; every fs error does.
    if (typeof code === "string") return { status: "file-unreadable", code };
    return { status: "file-invalid" };
  }
}

/**
 * When the environment variable is the active secret and no key file exists,
 * write the variable's value to the key file.
 *
 * Why: the earlier key Pinchy verifies against is always the key FILE
 * ({@link getPreviousSecret}). An install that set the variable from day one
 * never had that file, so switching the variable to a new value left every
 * entry signed with the old one verifying under no key at all, and the only
 * defence was a manual step in the docs. With the file written at startup,
 * the old value is already in place as the earlier key when the variable
 * changes. Safe by construction instead of by procedure.
 *
 * Never overwrites: an existing file is either the same key or the earlier
 * one, and the earlier one is the only thing that can verify the entries
 * signed with it. Even a corrupt file is left for the operator to look at,
 * but reported as "file-invalid": it is not a key anything can verify
 * against, so the current value is not saved, and saying nothing would read
 * exactly like a healthy file. A file that cannot be read at all is reported
 * as "file-unreadable" with the error code, for the same reason, and because
 * it may still be a good key.
 *
 * Written through {@link writeKeyFileExclusive}, after removing temp files an
 * earlier crash left behind.
 *
 * Never throws: a failed write is reported, and the caller logs it and starts
 * anyway.
 */
export function persistEnvSecretToKeyFile(name: string): EnvSecretPersistOutcome {
  const { keyFileDir, keyFilePath } = secretPaths(name);
  removeStaleKeyTempFilesOnce(keyFilePath);

  if (getSecretSource(name) !== "envvar") return { status: "not-envvar" };
  if (existsSync(keyFilePath)) return existingKeyFileOutcome(keyFilePath);

  // Same format as the file getOrCreateSecret generates: lowercase hex, no
  // trailing newline.
  const key = Buffer.from(process.env[name.toUpperCase()]!, "hex").toString("hex");
  try {
    return writeKeyFileExclusive(keyFilePath, key) === "written"
      ? { status: "written", dir: keyFileDir }
      : existingKeyFileOutcome(keyFilePath);
  } catch (err) {
    // fs errors name the code and the path, never the content written.
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

export function getOrCreateSecret(name: string): Buffer {
  const envVarName = name.toUpperCase();
  const { keyFileDir, keyFilePath } = secretPaths(name);
  removeStaleKeyTempFilesOnce(keyFilePath);

  switch (getSecretSource(name)) {
    case "envvar":
      return Buffer.from(process.env[envVarName]!, "hex");

    case "file":
      return readSecretFile(keyFilePath);

    case "unset": {
      // Auto-generate and persist
      if (existsSync(keyFileDir)) {
        const newKey = randomBytes(32).toString("hex");
        // Another process may have generated the key first; then that one is
        // the key, and replacing it would orphan whatever it already signed.
        if (writeKeyFileExclusive(keyFilePath, newKey) === "exists") {
          return readSecretFile(keyFilePath);
        }
        return Buffer.from(newKey, "hex");
      }
      throw new Error(
        `${envVarName} environment variable is required (64 hex characters) ` +
          "or a writable directory at " +
          keyFileDir
      );
    }
  }
}

export function getEncryptionKey(): Buffer {
  return getOrCreateSecret("encryption_key");
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format");
  }

  const [ivHex, authTagHex, encrypted] = parts;
  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error("Invalid ciphertext format");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
