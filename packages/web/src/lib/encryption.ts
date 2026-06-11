import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
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

export function getOrCreateSecret(name: string): Buffer {
  const envVarName = name.toUpperCase();
  const { keyFileDir, keyFilePath } = secretPaths(name);

  switch (getSecretSource(name)) {
    case "envvar":
      return Buffer.from(process.env[envVarName]!, "hex");

    case "file": {
      const fileKey = readFileSync(keyFilePath, "utf-8").trim();
      if (fileKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(fileKey)) {
        throw new Error(`Invalid secret in ${keyFilePath}: expected 64 hex characters`);
      }
      return Buffer.from(fileKey, "hex");
    }

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
