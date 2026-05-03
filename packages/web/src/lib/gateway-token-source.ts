import { randomBytes } from "crypto";
import { getSetting, setSetting } from "@/lib/settings";

const SETTING_KEY = "openclaw_gateway_token";

/**
 * Returns the gateway auth token, generating and persisting a new one if none
 * exists in the settings table. Token is 48 hex chars (24 random bytes).
 *
 * Pinchy owns the gateway token in the DB so regenerateOpenClawConfig() can
 * write the final config (including gateway.auth.token) before OpenClaw starts.
 */
export async function getOrCreateGatewayToken(): Promise<string> {
  const existing = await getSetting(SETTING_KEY);
  if (existing) return existing;

  const token = randomBytes(24).toString("hex");
  await setSetting(SETTING_KEY, token);
  return token;
}
