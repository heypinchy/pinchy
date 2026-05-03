import { randomBytes } from "crypto";
import { getSetting, setSetting } from "@/lib/settings";
import { readGatewayToken } from "@/lib/gateway-token-reader";

const SETTING_KEY = "openclaw_gateway_token";

/**
 * Returns the gateway auth token, generating and persisting a new one if none
 * exists. Priority order:
 *   1. Settings DB (authoritative once set).
 *   2. Existing openclaw.json / secrets.json — OpenClaw generates its own token
 *      at first startup when the config has no token (happens with the Pinchy-first
 *      startup order: Pinchy boots before OpenClaw, seeds a minimal config without
 *      a token, OpenClaw fills it in). Adopting this token keeps the client
 *      connection intact when regenerateOpenClawConfig() runs during setup.
 *   3. Fresh random token (48 hex chars, 24 random bytes).
 */
export async function getOrCreateGatewayToken(): Promise<string> {
  const existing = await getSetting(SETTING_KEY);
  if (existing) return existing;

  const configToken = readGatewayToken();
  if (configToken) {
    await setSetting(SETTING_KEY, configToken);
    return configToken;
  }

  const token = randomBytes(24).toString("hex");
  await setSetting(SETTING_KEY, token);
  return token;
}
