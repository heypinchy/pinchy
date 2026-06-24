import { isRetiredModelError } from "@/lib/model-retirement";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

/**
 * Runtime self-heal: when a chat/tool dispatch fails because the configured
 * model was retired upstream (HTTP 410 / "Unknown model"), regenerate the
 * OpenClaw config. `regenerateOpenClawConfig` re-resolves media models against
 * the LIVE `/v1/models` catalog (see `default-media-models.ts`) and skips the
 * write when nothing changed — so a retired model is swapped for a live one
 * without waiting for the next Pinchy upgrade or restart.
 *
 * OpenClaw has no fallback resolver of its own, so this is Pinchy's job. The
 * regeneration is debounced: a retirement makes EVERY dispatch fail the same
 * way, and we must not regenerate config (and trigger an OC hot-reload) on
 * every error in a burst.
 */
const SELF_HEAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

let lastHealAtMs = 0;

/**
 * Pure decision: should a retired-model error trigger a regeneration now?
 * Exposed for testing without faking timers or the heavy regenerate call.
 */
export function shouldSelfHeal(
  error: unknown,
  lastHealMs: number,
  nowMs: number,
  cooldownMs: number = SELF_HEAL_COOLDOWN_MS
): boolean {
  if (!isRetiredModelError(error)) return false;
  return nowMs - lastHealMs >= cooldownMs;
}

/**
 * Best-effort: if `error` signals a retired model and we're past the cooldown,
 * regenerate config. Never throws — a self-heal failure must not break the
 * caller's error-handling path. Returns true when a regeneration ran.
 */
export async function maybeSelfHealOnModelError(error: unknown): Promise<boolean> {
  const now = Date.now();
  if (!shouldSelfHeal(error, lastHealAtMs, now)) return false;
  lastHealAtMs = now;
  try {
    await regenerateOpenClawConfig();
    console.log(
      "[pinchy] Self-heal: regenerated OpenClaw config after a retired-model dispatch error"
    );
    return true;
  } catch (err) {
    console.error("[pinchy] Self-heal config regeneration failed:", err);
    return false;
  }
}

/** Test hook — reset the debounce clock between cases. */
export function _resetSelfHealState(): void {
  lastHealAtMs = 0;
}
