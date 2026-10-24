import { sql } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * The real, case-preserved `users.id` for an id read back from OpenClaw.
 *
 * OpenClaw lowercases session keys, so a user id taken from one never equals
 * the mixed-case `users.id` — and appendAuditLog's pseudonym substitution, the
 * approvals requester check and every other `eq(users.id, …)` miss it
 * silently. One lookup, so every internal route canonicalizes the same way.
 */
export async function findUserIdIgnoringCase(id: string): Promise<string | undefined> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.id}) = ${id.toLowerCase()}`);
  return rows[0]?.id;
}
