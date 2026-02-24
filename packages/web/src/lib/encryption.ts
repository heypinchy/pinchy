import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export function getOrCreateSecret(name: string): Buffer {
  const envVarName = name.toUpperCase();
  const fileName = `.${name}`;
  const keyFileDir = process.env.ENCRYPTION_KEY_DIR || "/app/secrets";
  const keyFilePath = join(keyFileDir, fileName);

  // Priority 1: Environment variable
  const envKey = process.env[envVarName];
  if (envKey && envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    return Buffer.from(envKey, "hex");
  }

  // Priority 2: Existing key file
  if (existsSync(keyFilePath)) {
    const fileKey = readFileSync(keyFilePath, "utf-8").trim();
    if (fileKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(fileKey)) {
      throw new Error(`Invalid secret in ${keyFilePath}: expected 64 hex characters`);
    }
    return Buffer.from(fileKey, "hex");
  }

  // Priority 3: Auto-generate and persist
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
