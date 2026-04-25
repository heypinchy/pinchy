// audit-exempt: read-only endpoint, no state change
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections, agentConnectionPermissions, agents } from "@/db/schema";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "admin")
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const { connectionId } = await params;
  const [existing] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (!existing) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

  const rows = await db
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agentConnectionPermissions)
    .innerJoin(agents, eq(agentConnectionPermissions.agentId, agents.id))
    .where(eq(agentConnectionPermissions.connectionId, connectionId));

  return NextResponse.json({ agents: rows });
}
