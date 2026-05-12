import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PREFIX = "pinchy_ref:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

export interface IntegrationRefPayload {
  integrationType: "odoo";
  connectionId: string;
  model: string;
  id: number;
  label: string;
}

let cachedKey: Buffer | null = null;

function isPayload(value: unknown): value is IntegrationRefPayload {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    obj.integrationType === "odoo" &&
    typeof obj.connectionId === "string" &&
    obj.connectionId.length > 0 &&
    typeof obj.model === "string" &&
    obj.model.length > 0 &&
    typeof obj.id === "number" &&
    Number.isInteger(obj.id) &&
    obj.id > 0 &&
    typeof obj.label === "string"
  );
}

function readKeyFile(keyPath: string): Buffer {
  const fileKey = readFileSync(keyPath, "utf-8").trim();
  if (fileKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(fileKey)) {
    throw new Error(`Invalid secret in ${keyPath}: expected 64 hex characters`);
  }
  return Buffer.from(fileKey, "hex");
}

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.PINCHY_REF_TOKEN_KEY;
  if (envKey) {
    if (envKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(envKey)) {
      throw new Error("PINCHY_REF_TOKEN_KEY must be 64 hex characters");
    }
    cachedKey = Buffer.from(envKey, "hex");
    return cachedKey;
  }

  const keyDir = process.env.ENCRYPTION_KEY_DIR || "/app/secrets";
  const keyPath = join(keyDir, ".integration_ref_key");
  if (existsSync(keyPath)) {
    cachedKey = readKeyFile(keyPath);
    return cachedKey;
  }

  if (existsSync(keyDir)) {
    const newKey = randomBytes(32).toString("hex");
    try {
      writeFileSync(keyPath, newKey, { mode: 0o600, flag: "wx" });
      cachedKey = Buffer.from(newKey, "hex");
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "";
      if (code !== "EEXIST") throw error;
      cachedKey = readKeyFile(keyPath);
    }
    return cachedKey;
  }

  throw new Error(
    "PINCHY_REF_TOKEN_KEY environment variable is required (64 hex characters) " +
      "or ENCRYPTION_KEY_DIR must point to a writable directory",
  );
}

export function encodeRef(payload: IntegrationRefPayload): string {
  if (!isPayload(payload)) {
    throw new Error("Invalid integration reference payload");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`;
}

export function decodeRef(ref: string): IntegrationRefPayload {
  if (!ref.startsWith(PREFIX)) {
    throw new Error("Invalid integration reference");
  }

  try {
    const raw = Buffer.from(ref.slice(PREFIX.length), "base64url");
    if (raw.length <= IV_LENGTH + 16) {
      throw new Error("too short");
    }
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = raw.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as unknown;
    if (!isPayload(payload)) {
      throw new Error("invalid payload");
    }
    return payload;
  } catch {
    throw new Error("Invalid integration reference");
  }
}

export function isIntegrationRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}
