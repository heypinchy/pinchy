import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, openSync, fstatSync, closeSync } from "fs";
import { join } from "path";

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
 * the ability to verify rows signed under it.
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

export function getOrCreateSecret(name: string): Buffer {
  const envVarName = name.toUpperCase();
  const { keyFileDir, keyFilePath } = secretPaths(name);

  switch (getSecretSource(name)) {
    case "envvar":
      return Buffer.from(process.env[envVarName]!, "hex");

    case "file":
      return readSecretFile(keyFilePath);

    case "unset": {
      // Auto-generate and persist
      if (existsSync(keyFileDir)) {
        const newKey = randomBytes(32).toString("hex");
        writeFileSync(keyFilePath, newKey, { mode: 0o600 });
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
