// audit-exempt: internal endpoint called by OpenClaw plugin, not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "@/lib/encryption";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { connectionId } = await params;

  const rows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const connection = rows[0];
  const credentials = JSON.parse(decrypt(connection.credentials));

  return NextResponse.json({ type: connection.type, credentials });
}
