import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { startMemoryAuditWatcher } from "./watcher";

/**
 * Wires the production-database `agents` lookup and the real audit-log
 * writer/failure recorder into `startMemoryAuditWatcher`. Kept as a thin
 * helper so `server.ts` doesn't need to import `@/db` at module scope —
 * the lazy `await import("./src/lib/memory-audit-watcher")` from server boot
 * defers DB-module evaluation until after `bootInits()` has completed.
 */
export async function bootstrapMemoryAuditWatcher(opts: {
  root?: string;
}): Promise<() => Promise<void>> {
  const root = opts.root ?? process.env.OPENCLAW_DATA_PATH ?? "/openclaw-config";

  const lookupAgent = async (agentId: string) => {
    const rows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return rows[0] ?? null;
  };

  return startMemoryAuditWatcher({
    root,
    lookupAgent,
    appendAuditLog,
    recordAuditFailure,
  });
}
