import { migrateSessionKeys } from "@/lib/session-migration";
import { loadDomainCache } from "@/lib/domain";
import { migrateToSecretRef } from "@/lib/openclaw-migration";
import { migrateGatewayTokenToDb } from "@/lib/migrate-gateway-token";
import {
  sanitizeOpenClawConfig,
  seedRestartClassOverridesIfMissing,
  seedGatewayTokenIfMissing,
  regenerateOpenClawConfig,
} from "@/lib/openclaw-config";
import { isSetupComplete } from "@/lib/setup";
import { migrateExistingSmithers } from "@/lib/migrate-onboarding";
import { migrateSmithersSoul } from "@/lib/migrate-smithers-soul";
import { markOpenClawConfigReady } from "@/lib/openclaw-config-ready";
import { seedBuiltinModels } from "@/lib/model-capabilities/seed";
import { loadModelCapabilityCache } from "@/lib/model-capabilities/cache";
import { checkSecretsVolumeWritable } from "@/lib/openclaw-secrets";
import { recordConfigRegenSuccess, recordConfigRegenFailure } from "@/lib/openclaw-config-health";

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

  // Seed gateway.auth.token before OC starts. OC 2026.5.12+ refuses to bind
  // on a non-loopback interface without an auth token ("Refusing to bind
  // gateway to lan without auth"). Earlier OC versions self-bootstrapped a
  // random token at first start; the strict check made the OC container
  // fail health-check on fresh installs because regenerateOpenClawConfig()
  // is gated behind isSetupComplete() and the wizard hasn't run yet.
  // Idempotent: no-op if the token is already present (post-wizard, or set
  // by a previous boot).
  try {
    if (await seedGatewayTokenIfMissing()) {
      console.log("[pinchy] Seeded gateway.auth.token into openclaw.json (pre-wizard bootstrap)");
    }
  } catch (err) {
    // The seed needs the DB (`getOrCreateGatewayToken` reads/writes a settings
    // row). If it fails here on a fresh install, openclaw.json carries no
    // `gateway.auth.token` and OC 2026.5.12+ will sit in its "Refusing to bind
    // gateway to lan without auth" restart loop until either the DB recovers
    // and a later `regenerateOpenClawConfig` writes the token, or the wizard
    // is run. Don't gate `markOpenClawConfigReady()` on this — Pinchy itself
    // must come up so the operator can fix the underlying DB issue. But make
    // the consequence loud so the operator isn't left wondering why OC's
    // healthcheck stays red.
    console.error(
      "[pinchy] FATAL: gateway token seed failed — OpenClaw will refuse to bind " +
        "until the token is written. Underlying error:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    await seedBuiltinModels();
    await loadModelCapabilityCache();
  } catch (err) {
    console.error(
      "[pinchy] Failed to seed built-in models:",
      err instanceof Error ? err.message : err
    );
  }

  // Preflight the secrets volume BEFORE regenerateOpenClawConfig() reaches its
  // writeSecretsFile() step. On an instance upgraded image-only (docker compose
  // pull, keeping a pre-existing docker-compose.yml), the `openclaw-secrets`
  // volume is absent and every regenerate throws EACCES mid-flight — freezing
  // openclaw.json so new providers/agents/models never reach OpenClaw (#878).
  // The generic "Failed to regenerate" catch below would only log a bare
  // EACCES; surface the actionable cause loudly and early instead.
  const secretsCheck = checkSecretsVolumeWritable();
  if (!secretsCheck.ok) {
    console.error(
      "[pinchy] FATAL: OpenClaw secrets volume is not writable — config " +
        "regeneration will fail and this instance will not pick up new " +
        "providers, agents, or model changes until it is fixed.\n" +
        secretsCheck.message
    );
    // Record it so /api/health flags the broken state even if setup is
    // incomplete (regenerate is skipped below) — a successful regenerate
    // clears it again. See recordConfigRegenSuccess/Failure (#879).
    recordConfigRegenFailure(secretsCheck.message);
  }

  let setupWasComplete = false;
  try {
    if (await isSetupComplete()) {
      await migrateExistingSmithers();

      // Bring un-customized Smithers souls up to the soul this build ships.
      // Own try/catch: SOUL.md drift must never cost the instance its config
      // regeneration below. Idempotent — one file read per agent once current.
      try {
        await migrateSmithersSoul();
      } catch (err) {
        console.error(
          "[pinchy] Failed to migrate Smithers souls:",
          err instanceof Error ? err.message : err
        );
      }

      await regenerateOpenClawConfig();
      console.log("[pinchy] OpenClaw config regenerated from DB state");
      // Clear any preflight-recorded failure: the boot regenerate completed.
      recordConfigRegenSuccess();
      setupWasComplete = true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[pinchy] Failed to regenerate OpenClaw config on startup:", message);
    // #879: readiness is marked below regardless (OpenClaw must be able to
    // start), so record the failure separately. Without this, /api/health
    // reports a perfectly healthy instance while config generation is broken —
    // exactly the silent state observed on the apsa v0.8.0 box.
    recordConfigRegenFailure(message);
  }

  // Signal the Docker Compose healthcheck that Pinchy has finished its startup
  // sequence. OpenClaw depends on this to start. Called unconditionally so the
  // healthcheck passes even on fresh installs (no setup yet) or when config
  // regeneration fails — OpenClaw will start with whatever config is on disk
  // and hot-reload via inotify when the setup wizard writes a new one. The
  // regeneration OUTCOME is tracked separately via recordConfigRegen* above and
  // surfaced through /api/health, so a green healthcheck no longer hides a
  // broken config generation (#879).
  console.log("[pinchy] boot complete: OpenClaw container may now start");
  markOpenClawConfigReady();

  return setupWasComplete;
}
