import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";

const PREFIX = "pinchy_ref:v1:";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const DEFAULT_SECRETS_PATH = "/openclaw-secrets/secrets.json";
const HEX_64 = /^[0-9a-fA-F]{64}$/;

export interface IntegrationRefPayload {
  integrationType: "odoo";
  connectionId: string;
  model: string;
  id: number;
  label: string;
  // Optional company tag for multi-company tenants. Present when the encoder
  // could see the record's company_id at wrap time. Allows downstream
  // consumers (refToId) to refuse cross-company writes without an extra
  // Odoo round-trip. Both fields appear together or not at all.
  companyId?: number;
  companyLabel?: string;
}

let cachedKey: Buffer | null = null;

/**
 * Test-only: clears the in-memory cached key so a test can change the source
 * (env var, secrets file) and re-derive on the next encode/decode call.
 */
export function _resetKeyCacheForTest(): void {
  cachedKey = null;
}

function isPayload(value: unknown): value is IntegrationRefPayload {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const base =
    obj.integrationType === "odoo" &&
    typeof obj.connectionId === "string" &&
    obj.connectionId.length > 0 &&
    typeof obj.model === "string" &&
    obj.model.length > 0 &&
    typeof obj.id === "number" &&
    Number.isInteger(obj.id) &&
    obj.id > 0 &&
    typeof obj.label === "string";
  if (!base) return false;

  // Company tag rules: both present together, both correct shape, or neither.
  const hasId = "companyId" in obj && obj.companyId !== undefined;
  const hasLabel = "companyLabel" in obj && obj.companyLabel !== undefined;
  if (hasId !== hasLabel) return false;
  if (hasId) {
    if (
      typeof obj.companyId !== "number" ||
      !Number.isInteger(obj.companyId) ||
      obj.companyId <= 0
    )
      return false;
    if (typeof obj.companyLabel !== "string" || obj.companyLabel.length === 0) {
      return false;
    }
  }
  return true;
}

function readKeyFromSecretsBundle(): string | null {
  const path = process.env.OPENCLAW_SECRETS_PATH || DEFAULT_SECRETS_PATH;
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const plugins = (parsed as Record<string, unknown>).plugins;
    if (!plugins || typeof plugins !== "object") return null;
    const odooPlugin = (plugins as Record<string, unknown>)["pinchy-odoo"];
    if (!odooPlugin || typeof odooPlugin !== "object") return null;
    const key = (odooPlugin as Record<string, unknown>).refTokenKey;
    return typeof key === "string" ? key : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the integration-ref encryption key.
 *
 * Source priority:
 *   1. `PINCHY_REF_TOKEN_KEY` env var (tests, local dev, override)
 *   2. `plugins["pinchy-odoo"].refTokenKey` in the shared secrets bundle
 *      at `/openclaw-secrets/secrets.json` (production — written by
 *      pinchy-web's `collectPluginSecrets()` on `regenerateOpenClawConfig()`).
 *
 * No file-system fallback: the plugin no longer auto-generates a key into
 * a local directory. Earlier versions did, but that path silently broke in
 * Docker deployments where `/app/secrets` doesn't exist in the OC
 * container, and it produced different keys per container instance — both
 * encryption fails. Pinchy is now the single source of truth.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.PINCHY_REF_TOKEN_KEY;
  if (envKey) {
    if (!HEX_64.test(envKey)) {
      throw new Error("PINCHY_REF_TOKEN_KEY must be 64 hex characters");
    }
    cachedKey = Buffer.from(envKey, "hex");
    return cachedKey;
  }

  const bundleKey = readKeyFromSecretsBundle();
  if (bundleKey) {
    if (!HEX_64.test(bundleKey)) {
      throw new Error(
        "plugins['pinchy-odoo'].refTokenKey in secrets.json is invalid: expected 64 hex characters",
      );
    }
    cachedKey = Buffer.from(bundleKey, "hex");
    return cachedKey;
  }

  throw new Error(
    "PINCHY_REF_TOKEN_KEY environment variable is required (64 hex characters) " +
      "or pinchy-web must have written secrets.json with plugins['pinchy-odoo'].refTokenKey. " +
      "If you upgraded an existing deployment, restart the pinchy service to trigger " +
      "regenerateOpenClawConfig() and provision the key.",
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
