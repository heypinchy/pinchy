import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { agentConnectionPermissions } from "@/db/schema";
import { EMAIL_READ_OPERATIONS } from "@/lib/tool-registry";

/**
 * Of the requested connection ids, return those the agent may NOT read.
 *
 * A workflow's trigger lists and reads mail, so a draft/send-only grant is not
 * enough — only an email-READ permission qualifies. `EMAIL_READ_OPERATIONS`
 * includes the legacy "search"/"list" aliases the runtime already treats as
 * read. An unknown connection id has no permission row either, so this single
 * check rejects "no read access" and "no such connection" alike.
 *
 * Shared by BOTH write paths — create (POST) and edit (PUT) — deliberately: a
 * workflow must never point at a mailbox its agent can't open, and if the two
 * paths validated this separately they could drift into a hole where one accepts
 * what the other (and the runtime) forbids. One function, one boundary.
 */
export async function findUnreadableConnectionIds(
  agentId: string,
  requestedConnectionIds: string[]
): Promise<string[]> {
  const requested = [...new Set(requestedConnectionIds)];
  if (requested.length === 0) return [];
  const permittedRows = await db
    .selectDistinct({ connectionId: agentConnectionPermissions.connectionId })
    .from(agentConnectionPermissions)
    .where(
      and(
        eq(agentConnectionPermissions.agentId, agentId),
        eq(agentConnectionPermissions.model, "email"),
        inArray(agentConnectionPermissions.operation, [...EMAIL_READ_OPERATIONS]),
        inArray(agentConnectionPermissions.connectionId, requested)
      )
    );
  const permitted = new Set(permittedRows.map((r) => r.connectionId));
  return requested.filter((id) => !permitted.has(id));
}
