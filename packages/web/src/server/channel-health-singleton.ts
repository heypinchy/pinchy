import type { ChannelHealthMonitor } from "./channel-health-watchdog";

// Share the channel-health monitor across module boundaries. Next.js may load
// API routes in a separate module context from server.ts, so a plain
// module-level variable wouldn't be visible to `/api/health/openclaw`
// (mirrors openclaw-client.ts). The route reads the monitor's debounced
// per-episode snapshot so the "degraded" badge reflects the watchdog's
// authoritative state rather than flickering on a single-tick blip.
const GLOBAL_KEY = "__channelHealthMonitor" as const;

declare global {
  var __channelHealthMonitor: ChannelHealthMonitor | undefined;
}

export function setChannelHealthMonitor(monitor: ChannelHealthMonitor): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = monitor;
}

/** The process-wide monitor, or undefined before the watchdog has started. */
export function getChannelHealthMonitor(): ChannelHealthMonitor | undefined {
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as ChannelHealthMonitor | undefined;
}
