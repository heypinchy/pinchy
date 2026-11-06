import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

/**
 * Rewrite openclaw.json after the web-search connection is added or removed.
 *
 * pinchy-web reads its `connectionId` once, when OpenClaw registers it, and
 * web agents run the plugin without one while no provider exists (#1297).
 * Without this, adding a Brave key leaves search answering "not configured"
 * — and removing it leaves a stale id — until some unrelated save rewrites
 * the config.
 *
 * Best effort: the connection row is already written, so a regenerate that
 * fails must not turn the request into a 500. Boot and the next agent save
 * regenerate again.
 */
export async function refreshWebPluginConfig(): Promise<void> {
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("[integrations] Failed to apply the web-search change to OpenClaw:", err);
  }
}
