import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { toolApproval, agents } from "@/db/schema";

/**
 * The caller's own pending confirmations, for the inline chat card.
 * audit-exempt: read-only listing.
 */
export const GET = withAuth(async (_req, _ctx, session) => {
  const approvals = await db
    .select({
      id: toolApproval.id,
      agentId: toolApproval.agentId,
      agentName: agents.name,
      toolName: toolApproval.toolName,
      argsSummary: toolApproval.argsSummary,
      sessionKey: toolApproval.sessionKey,
      createdAt: toolApproval.createdAt,
      expiresAt: toolApproval.expiresAt,
    })
    .from(toolApproval)
    .innerJoin(agents, eq(agents.id, toolApproval.agentId))
    .where(and(eq(toolApproval.requesterId, session.user.id!), eq(toolApproval.status, "pending")))
    .orderBy(desc(toolApproval.createdAt));

  return NextResponse.json({ approvals });
});
