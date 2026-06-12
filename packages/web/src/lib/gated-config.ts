import { count, and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, groups } from "@/db/schema";

/**
 * Whether any license-gated configuration exists: groups, or shared agents
 * with restricted visibility. Used to decide if the "Remove all
 * license-gated configuration" escape hatch (pricing concept § 5) applies.
 */
export async function hasGatedConfig(): Promise<boolean> {
  const [groupRows, restrictedAgentRows] = await Promise.all([
    db.select({ count: count() }).from(groups),
    db
      .select({ count: count() })
      .from(agents)
      .where(
        and(
          eq(agents.visibility, "restricted"),
          eq(agents.isPersonal, false),
          isNull(agents.deletedAt)
        )
      ),
  ]);
  return groupRows[0].count > 0 || restrictedAgentRows[0].count > 0;
}
