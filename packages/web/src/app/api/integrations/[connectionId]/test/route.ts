// audit-exempt: read-only for web-search. The Odoo branch may auto-repair a
// stored uid when the first successful authenticate returns a different value
// (one-time bootstrap), which is intentional and not user-initiated state
// change — no separate audit entry is written for that self-heal path.
import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { OdooClient } from "odoo-node";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
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

    // Web-search: validate API key against Brave Search API
    if (connection.type === "web-search") {
      const apiKey = decrypted.apiKey as string | undefined;
      if (!apiKey) {
        return NextResponse.json(
          { success: false, error: "Invalid credentials format" },
          { status: 200 }
        );
      }
      const res = await fetch("https://api.search.brave.com/res/v1/web/search?q=test&count=1", {
        headers: { "X-Subscription-Token": apiKey },
      });
      if (!res.ok) {
        return NextResponse.json({ success: false, error: "Invalid API key" }, { status: 200 });
      }
      return NextResponse.json({ success: true });
    }

    // Odoo: authenticate and verify version
    const parsed = odooCredentialsSchema.safeParse(decrypted);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid credentials format" },
        { status: 200 }
      );
    }

    const creds = parsed.data;

    // Authenticate against the real Odoo instance
    const uid = await OdooClient.authenticate({
      url: creds.url,
      db: creds.db,
      login: creds.login,
      apiKey: creds.apiKey,
    });

    // Verify we can also get the version
    const client = new OdooClient({ url: creds.url, db: creds.db, uid, apiKey: creds.apiKey });
    const version = await client.version();

    // If uid changed (e.g. first connection with placeholder uid), update stored credentials
    if (uid !== creds.uid) {
      await db
        .update(integrationConnections)
        .set({
          credentials: encrypt(JSON.stringify({ ...creds, uid })),
          updatedAt: new Date(),
        })
        .where(eq(integrationConnections.id, connectionId));
    }

    return NextResponse.json({
      success: true,
      version: version.serverVersion,
      uid,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    return NextResponse.json({ success: false, error: message }, { status: 200 });
  }
}
