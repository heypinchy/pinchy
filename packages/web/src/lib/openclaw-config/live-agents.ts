import { and, inArray, isNull } from "drizzle-orm";

/**
 * Which of `ids` Pinchy's database still holds as live agents (not
 * soft-deleted). A config push asks before it removes an agent from
 * OpenClaw's roster with `agents.delete` (write.ts): the payload alone cannot
 * say an agent is gone — a targeted writer's copy of openclaw.json can predate
 * an agent's creation — and `deleteFiles: true` removes the agent's workspace.
 *
 * Imports the database lazily: write.ts is loaded by code paths and tests that
 * never reach a roster removal.
 */
export async function liveAgentIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [{ db }, { agents }] = await Promise.all([import("@/db"), import("@/db/schema")]);
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(inArray(agents.id, ids), isNull(agents.deletedAt)));
  return new Set(rows.map((row) => row.id));
}
