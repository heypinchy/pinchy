import { existsSync, readFileSync } from "fs";
import { getSetting, setSetting } from "@/lib/settings";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
const SETTING_KEY = "openclaw_gateway_token";

/**
 * One-time migration: read the gateway auth token from the existing
 * openclaw.json and persist it in the settings DB so Pinchy owns it.
 *
 * DB wins: if the setting already exists (e.g. from a previous boot),
 * the existing-config token is ignored — no double-write, no overwrite.
 *
 * Called from server.ts boot before regenerateOpenClawConfig() so that
 * Phase 4's dependency inversion (OpenClaw waits for Pinchy's config)
 * has the token available before writing the first final openclaw.json.
 */
export async function migrateGatewayTokenToDb(): Promise<void> {
  const existing = await getSetting(SETTING_KEY);
  if (existing) return;

  if (!existsSync(CONFIG_PATH)) return;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return;
  }

  const gateway = config.gateway as Record<string, unknown> | undefined;
  const auth = gateway?.auth as Record<string, unknown> | undefined;
  const token = auth?.token;

  if (typeof token !== "string" || !token) return;

  await setSetting(SETTING_KEY, token);
}
