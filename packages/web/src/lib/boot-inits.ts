import { migrateSessionKeys } from "@/lib/session-migration";
import { loadDomainCache } from "@/lib/domain";
import { migrateToSecretRef } from "@/lib/openclaw-migration";
import { migrateGatewayTokenToDb } from "@/lib/migrate-gateway-token";
import {
  sanitizeOpenClawConfig,
  seedRestartClassOverridesIfMissing,
  regenerateOpenClawConfig,
} from "@/lib/openclaw-config";
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

  // Pre-seed Pinchy's restart-class overrides into openclaw.json BEFORE OC
  // starts. Without this seed, the very first WS-driven config.apply (e.g.
  // from POST /api/setup) produces a diff at `gateway.controlUi.enabled`,
  // `update`, `discovery`, `canvasHost` (per OC 5.3 BASE_RELOAD_RULES_TAIL,
  // these are restart-class). The reload subsystem fires SIGUSR1 → in-process
  // restart → OC's `ensureGatewayStartupAuth → replaceConfigFile` hits the
  // stale-snapshot bug and crashes the gateway with
  // `ConfigMutationConflictError: config changed since last load`. Telegram
  // E2E `agent-create-no-restart.spec.ts` reproduces this on every other CI
  // run as "OpenClaw never quiet for 30000ms within 240000ms".
  // Idempotent: if the file already carries the four overrides (production
  // case — Docker-managed named volume populated from the image's baked-in
  // config/openclaw.json), this is a no-op. Targeted to ONLY the four restart-
  // class fields (full bootInits regenerate broke the integration test's
  // basic chat by producing a stale agents/models block that interfered with
  // OC's model registry on later hot-reload).
  try {
    if (seedRestartClassOverridesIfMissing()) {
      console.log(
        "[pinchy] Seeded restart-class overrides into openclaw.json (cascade-prevention baseline)"
      );
    }
  } catch (err) {
    console.error(
      "[pinchy] Failed to seed restart-class overrides:",
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
