import { randomBytes } from "crypto";
import { getSetting, setSetting } from "@/lib/settings";

const SETTING_PREFIX = "plugin_secret:";
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Get-or-create a stable 64-hex-character secret for a plugin, persisted in
 * the settings DB.
 *
 * Pattern mirrors `getOrCreateGatewayToken()`: the DB is the source of truth,
 * Pinchy materialises the value into the shared `secrets.json` bundle via
 * `buildSecretsBundle()`, and OC-side plugins read it from there (or from
 * an env-var override for dev/test).
 *
 * The `name` is the per-plugin identifier (e.g. "pinchy-odoo:ref-token-key").
 * Pick stable names — rotating the name resets the secret and invalidates
 * anything encrypted under the old one.
 */
export async function getOrCreatePluginSecret(name: string): Promise<string> {
  const key = `${SETTING_PREFIX}${name}`;
  const existing = await getSetting(key);
  if (existing && HEX_64.test(existing)) return existing;

  const secret = randomBytes(32).toString("hex");
  await setSetting(key, secret);
  return secret;
}
