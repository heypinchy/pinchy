import { migrateSessionKeys } from "@/lib/session-migration";
import { loadDomainCache } from "@/lib/domain";
import { migrateToSecretRef } from "@/lib/openclaw-migration";
import { migrateGatewayTokenToDb } from "@/lib/migrate-gateway-token";
import { sanitizeOpenClawConfig, regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { isSetupComplete } from "@/lib/setup";
import { migrateExistingSmithers } from "@/lib/migrate-onboarding";
import { markOpenClawConfigReady } from "@/lib/openclaw-config-ready";

/**
 * Runs all one-time boot initializations in the correct order and performs
 * exactly one call to regenerateOpenClawConfig() at the end.
 *
 * Returns true if config was regenerated (setup complete), false otherwise.
 */
export async function bootInits(): Promise<boolean> {
  const openclawDataPath = process.env.OPENCLAW_DATA_PATH || "/openclaw-config";
  const configPath = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

  try {
    migrateSessionKeys(openclawDataPath);
  } catch {
    // Non-critical — old sessions start fresh
  }

  try {
    await loadDomainCache();
  } catch (err) {
    console.error(
      "[pinchy] Failed to load domain cache:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    migrateToSecretRef(configPath);
  } catch (err) {
    console.error(
      "[pinchy] Failed to run secret-ref migration:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    await migrateGatewayTokenToDb();
  } catch (err) {
    console.error(
      "[pinchy] Failed to migrate gateway token to DB:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    if (sanitizeOpenClawConfig()) {
      console.log("[pinchy] Sanitized OpenClaw config (removed stale plugin allow entries)");
    }
  } catch (err) {
    console.error(
      "[pinchy] Failed to sanitize OpenClaw config:",
      err instanceof Error ? err.message : err
    );
  }

  let setupWasComplete = false;
  try {
    if (await isSetupComplete()) {
      await migrateExistingSmithers();
      await regenerateOpenClawConfig();
      console.log("[pinchy] OpenClaw config regenerated from DB state");
      setupWasComplete = true;
    }
  } catch (err) {
    console.error(
      "[pinchy] Failed to regenerate OpenClaw config on startup:",
      err instanceof Error ? err.message : err
    );
  }

  // Signal the Docker Compose healthcheck that Pinchy has finished its startup
  // sequence. OpenClaw depends on this to start. Called unconditionally so the
  // healthcheck passes even on fresh installs (no setup yet) or when config
  // regeneration fails — OpenClaw will start with whatever config is on disk
  // and hot-reload via inotify when the setup wizard writes a new one.
  console.log("[pinchy] boot complete: OpenClaw container may now start");
  markOpenClawConfigReady();

  return setupWasComplete;
}
