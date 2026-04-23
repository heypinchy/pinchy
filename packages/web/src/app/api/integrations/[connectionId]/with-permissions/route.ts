// audit-exempt: audit log is written by finalizeIntegrationDeletion after successful deletion
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections, agentConnectionPermissions, agents } from "@/db/schema";
import { finalizeIntegrationDeletion } from "@/lib/integrations/finalize-deletion";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin")
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const { connectionId } = await params;
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (!existing) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

  const detachedAgents = await db.transaction(async (tx) => {
    const snapshot = await tx
      .selectDistinct({ id: agents.id, name: agents.name })
      .from(agentConnectionPermissions)
      .innerJoin(agents, eq(agentConnectionPermissions.agentId, agents.id))
      .where(eq(agentConnectionPermissions.connectionId, connectionId));

    await tx
      .delete(agentConnectionPermissions)
      .where(eq(agentConnectionPermissions.connectionId, connectionId));

    await tx.delete(integrationConnections).where(eq(integrationConnections.id, connectionId));

    return snapshot;
  });

  await finalizeIntegrationDeletion({
    actorId: session.user.id!,
    connection: existing,
    detachedAgents,
  });

  return NextResponse.json({ success: true });
}
