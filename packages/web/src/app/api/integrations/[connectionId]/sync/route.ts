// audit-exempt: placeholder endpoint, no state changes yet (will need audit when implemented)
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { connectionId } = await params;

  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // TODO: Implement schema sync when odoo-node is installed in Pinchy
  // 1. Decrypt credentials
  // 2. Create OdooClient
  // 3. Fetch models via client.models()
  // 4. Fetch fields per model
  // 5. Store in `data` jsonb column

  return NextResponse.json({
    success: false,
    error: "Not yet implemented — odoo-node package required",
  });
}
