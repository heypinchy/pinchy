/**
 * Classify a usage record by its `sessionKey` into one of three buckets
 * shown on the Usage Dashboard:
 *
 *   - "chat":   direct browser/Telegram chat with an agent
 *               (sessionKey shape: `agent:<agentId>:direct:<userId>`)
 *   - "plugin": LLM calls made by a plugin outside of agent sessions,
 *               e.g. pinchy-files vision API for scanned PDFs
 *               (sessionKey shape: `plugin:<pluginId>`)
 *   - "system": everything else — main/heartbeat, cron jobs, webhooks,
 *               and any unrecognized shape (fail-safe default).
 */

export type UsageSource = "chat" | "system" | "plugin";

export function classifyUsageSource(sessionKey: string): UsageSource {
  if (sessionKey.startsWith("plugin:")) return "plugin";
  if (/^agent:[^:]+:direct:/.test(sessionKey)) return "chat";
  return "system";
}
