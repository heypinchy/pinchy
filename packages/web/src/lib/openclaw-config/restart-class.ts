import { isDeepStrictEqual } from "util";

/**
 * Top-level config blocks that OC 5.3 treats as restart-class. Any change to
 * one of these triggers a full gateway restart (SIGUSR1 → in-process restart),
 * unlike hot-reload blocks (agents, models, plugins.entries) which OC applies
 * without restarting.
 *
 * Mirrors OC's BASE_RELOAD_RULES_TAIL `kind: "restart"` entries. Documented
 * in seedRestartClassOverridesIfMissing() (targeted.ts) for the pre-startup
 * cascade prevention path. `channels` and `bindings` are added based on
 * empirical CI evidence: adding/removing a channel block or binding triggers
 * `[reload] config change requires gateway restart (channels)`.
 *
 * If a future OC release adds or removes restart-class blocks, this list and
 * the assertion in openclaw-config-restart-class.test.ts must move in lockstep.
 */
export const RESTART_CLASS_PATHS = [
  "gateway",
  "discovery",
  "canvasHost",
  "update",
  "channels",
  "bindings",
] as const;

/**
 * Returns true if any restart-class block differs between the two configs.
 * Deep structural compare (key order doesn't matter). Used by
 * regenerateOpenClawConfig to decide whether to mark the server-side restart
 * state so /api/health/openclaw reflects the pending OC restart.
 */
export function isRestartClassDiff(
  oldCfg: Record<string, unknown>,
  newCfg: Record<string, unknown>
): boolean {
  for (const path of RESTART_CLASS_PATHS) {
    if (!isDeepStrictEqual(oldCfg[path], newCfg[path])) {
      return true;
    }
  }
  return false;
}
