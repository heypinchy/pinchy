// Tracks the outcome of the most recent boot-time OpenClaw config regeneration,
// kept deliberately SEPARATE from the OpenClaw-startup readiness gate in
// openclaw-config-ready.ts.
//
// Why separate (issue #879): markOpenClawConfigReady() MUST fire unconditionally
// so the OpenClaw container — which waits on `depends_on: pinchy service_healthy`
// — can start and hot-reload a fixed config later, even when the boot-time
// regenerate throws. That is correct for startup ordering but made readiness
// *lie*: the healthcheck went green and OpenClaw started while config generation
// was fundamentally broken (e.g. the #878 missing-secrets-volume EACCES), with
// nothing external signalling the broken state. This module records that
// outcome so /api/health can surface the failure to monitoring and the admin UI
// WITHOUT gating OpenClaw's startup on it.
//
// globalThis-backed for the same reason as the ready flag: the state is written
// from server.ts (tsx module scope, via bootInits) and read from a Next.js API
// route (webpack module scope); a module-level `let` is not shared between them.

const KEY = "__pinchyOpenClawConfigRegenState";

export type ConfigRegenState = {
  /** false only when the most recent boot-time regeneration attempt failed. */
  ok: boolean;
  /**
   * Operator-facing message when `ok` is false. Carries the actionable cause
   * (e.g. the missing-volume guidance from checkSecretsVolumeWritable). Never
   * contains secret material — it is safe to expose via /api/health.
   */
  error?: string;
  /** ISO timestamp of the most recent recorded attempt. */
  at?: string;
};

export function recordConfigRegenSuccess(): void {
  (globalThis as Record<string, unknown>)[KEY] = {
    ok: true,
    at: new Date().toISOString(),
  } satisfies ConfigRegenState;
}

export function recordConfigRegenFailure(error: string): void {
  (globalThis as Record<string, unknown>)[KEY] = {
    ok: false,
    error,
    at: new Date().toISOString(),
  } satisfies ConfigRegenState;
}

export function getConfigRegenState(): ConfigRegenState {
  const state = (globalThis as Record<string, unknown>)[KEY] as ConfigRegenState | undefined;
  // Default: no failure recorded. Either boot hasn't reached regeneration yet,
  // or setup isn't complete so no regenerate has run. Report ok so a
  // never-yet-regenerated instance isn't falsely flagged as broken.
  return state ?? { ok: true };
}
