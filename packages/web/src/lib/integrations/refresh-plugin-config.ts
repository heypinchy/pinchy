import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

/**
 * Rewrite openclaw.json after an integration connection is added or removed.
 *
 * Every connection type feeds a plugin config: pinchy-web carries the
 * web-search `connectionId`, pinchy-odoo and pinchy-email carry one per agent
 * that holds a grant on the connection. The plugins read it once, when
 * OpenClaw registers them, so a stale config means a stale id: adding a Brave
 * key left search answering "not configured" (#1297), and deleting a
 * connection (which cascades its agent grants away) left pinchy-odoo and
 * pinchy-email pointing at a row that no longer exists — until some unrelated
 * save rewrote the config. Callers do not filter by type; a change that
 * leaves the config identical is skipped by the push itself.
 *
 * Best effort: the connection row is already written, so a regenerate that
 * fails must not turn the request into a 500. Boot and the next agent save
 * regenerate again.
 */
export async function refreshPluginConfig(): Promise<void> {
  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("[integrations] Failed to apply the integration change to OpenClaw:", err);
  }
}
