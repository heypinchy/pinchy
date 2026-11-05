/**
 * Boot-time cleanup for #1272: take out of every agent row the
 * `pinchy-files.allowed_paths` entries that lie outside /data.
 *
 * Before v0.9.1 the agent PATCH accepted any path, from any member on their own
 * agent; the lockdown confined new writes and left old rows as they were.
 * `grantedDataPaths` already stops every reader from honouring such an entry,
 * so this is not what closes the hole. It exists for two other reasons:
 *
 *   - An admin can see it. Each row it rewrites gets an `agent.updated` audit
 *     row naming the dropped entries, so a grant that disappears on upgrade
 *     does not disappear silently.
 *   - The settings form keeps working. Saving sends `allowed_paths` back
 *     through `pluginConfigSchema`, which rejects the whole save over an entry
 *     outside /data that the admin never sees in the folder picker.
 *
 * Done in TypeScript at boot rather than as a SQL migration because a SQL
 * migration cannot write the HMAC-chained audit row. Idempotent: a clean row
 * is read and left alone, so later boots write nothing.
 */
import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { agents, type AgentPluginConfig } from "@/db/schema";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { grantedDataPaths, ungrantablePaths } from "@/lib/agent-granted-paths";

/** Returns the number of agent rows rewritten. */
export async function stripUngrantablePaths(): Promise<number> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, pluginConfig: agents.pluginConfig })
    .from(agents)
    .where(isNotNull(agents.pluginConfig));

  let rewritten = 0;
  for (const row of rows) {
    const config = row.pluginConfig as AgentPluginConfig;
    const removed = ungrantablePaths(config);
    if (removed.length === 0) continue;

    const before = config["pinchy-files"]?.allowed_paths ?? [];
    const kept = grantedDataPaths(config);
    const next: AgentPluginConfig = {
      ...config,
      "pinchy-files": { ...config["pinchy-files"], allowed_paths: kept },
    };

    // Compare-and-set on the value just read: a concurrent admin save wins,
    // and the next boot looks at whatever it wrote.
    const updated = await db
      .update(agents)
      .set({ pluginConfig: next })
      .where(and(eq(agents.id, row.id), eq(agents.pluginConfig, config)))
      .returning({ id: agents.id });
    if (updated.length === 0) continue;
    rewritten++;

    const entry: AuditLogEntry = {
      actorType: "system",
      actorId: "system",
      eventType: "agent.updated",
      resource: `agent:${row.id}`,
      detail: {
        agent: { id: row.id, name: row.name },
        reason: "allowed_paths_outside_data_root",
        removed,
        changes: { allowedPaths: { from: before, to: kept } },
      },
      outcome: "success",
    };
    try {
      await appendAuditLog(entry);
    } catch (err) {
      recordAuditFailure(err, entry);
    }
  }
  return rewritten;
}
