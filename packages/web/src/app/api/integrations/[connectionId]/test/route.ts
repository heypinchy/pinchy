// audit-exempt: read-only connection test, no state changes
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";

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

  try {
    const decrypted = JSON.parse(decrypt(connection.credentials));
    const parsed = odooCredentialsSchema.safeParse(decrypted);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid credentials format" },
        { status: 200 }
      );
    }

    // TODO: Wire up real Odoo authentication test when odoo-node is installed in Pinchy
    // const client = new OdooClient(parsed.data);
    // await client.authenticate();

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { success: false, error: "Failed to validate credentials" },
      { status: 200 }
    );
  }
}
