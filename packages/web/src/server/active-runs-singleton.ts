import { ActiveRuns } from "@/server/active-runs";

/**
 * Process-singleton `ActiveRuns` registry.
 *
 * Shared via `globalThis` for the same reason `openclaw-client.ts` does: Next.js
 * may load API routes in a separate module context from the custom server, so a
 * plain module-level variable wouldn't be reliably shared. Today only the
 * custom server (`server.ts`) and the `ClientRouter` it constructs touch this,
 * but routing it through `globalThis` keeps the option open for an API route
 * that needs to look up an active run (e.g. an admin "force-abort" endpoint).
 */
const GLOBAL_KEY = "__pinchyActiveRuns" as const;

declare global {
  // eslint-disable-next-line no-var
  var __pinchyActiveRuns: ActiveRuns | undefined;
}

export function getActiveRunsSingleton(): ActiveRuns {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as ActiveRuns | undefined;
  if (existing) return existing;
  const fresh = new ActiveRuns();
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fresh;
  return fresh;
}
