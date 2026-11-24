import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentConnectionPermissions, settings } from "@/db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The per-agent settings keys a Telegram bot leaves behind. */
function telegramSettingKeys(agentId: string): string[] {
  return [
    `telegram_bot_token:${agentId}`,
    `telegram_bot_username:${agentId}`,
    `telegram_conflict_disabled:${agentId}`,
  ];
}

/**
 * Soft-delete agents together with everything that would otherwise keep
 * acting for them, inside the caller's transaction.
 *
 * The row is kept (`deletedAt`) so chat history and audit references stay
 * resolvable. Its grants are not: the FK cascade on
 * `agent_connection_permissions` only fires on a hard delete, and the MCP
 * proxy, the credentials route and the Odoo/email config loops all read
 * grants. A grant that outlives its agent keeps a connection open for no one
 * an admin can still see. The Telegram bot settings go for the same reason —
 * a token left behind keeps a deleted agent's bot configured.
 *
 * Every path that soft-deletes an agent goes through here: deleting one agent
 * and deactivating a user who owns personal agents. Readers still filter on
 * `deletedAt` as well; this is the write side of the same rule.
 */
export async function softDeleteAgentRows(tx: Transaction, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const agentIds = [...ids];

  const rows = await tx
    .update(agents)
    .set({ deletedAt: new Date() })
    .where(inArray(agents.id, agentIds))
    .returning();

  await tx
    .delete(agentConnectionPermissions)
    .where(inArray(agentConnectionPermissions.agentId, agentIds));

  await tx.delete(settings).where(inArray(settings.key, agentIds.flatMap(telegramSettingKeys)));

  return rows;
}
