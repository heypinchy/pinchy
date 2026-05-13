// audit-exempt: audit writes happen indirectly via setIntegrationAuthFailed (integration.auth_failed)
// and clearIntegrationAuthError (integration.auth_recovered) on status transitions. The Odoo uid
// self-heal path intentionally writes no audit entry — it is a one-time bootstrap, not a
// user-initiated change.
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { OdooClient } from "odoo-node";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/encryption";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";
import { clearIntegrationAuthError, setIntegrationAuthFailed } from "@/lib/integrations/auth-state";

type RouteContext = { params: Promise<{ connectionId: string }> };

export const POST = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { connectionId } = await params;
  const actor = { type: "user" as const, id: session.user.id! };

  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  try {
    const decrypted = JSON.parse(decrypt(connection.credentials));

    // Odoo uid self-heal: if the authenticate call returns a different uid than
    // what is stored (e.g. first connection with a placeholder), update the stored
    // credentials. This must happen before the probe so the probe uses the correct uid.
    if (connection.type === "odoo") {
      const parsed = odooCredentialsSchema.safeParse(decrypted);
      if (parsed.success) {
        const creds = parsed.data;
        const uid = await OdooClient.authenticate({
          url: creds.url,
          db: creds.db,
          login: creds.login,
          apiKey: creds.apiKey,
        });
        if (uid !== creds.uid) {
          decrypted.uid = uid;
          await db
            .update(integrationConnections)
            .set({
              credentials: encrypt(JSON.stringify({ ...creds, uid })),
              updatedAt: new Date(),
            })
            .where(eq(integrationConnections.id, connectionId));
        }
      }
    }

    const probe = await probeIntegrationCredentials(connection.type, decrypted);

    if (probe.success) {
      await clearIntegrationAuthError({ connectionId, actor });
      return NextResponse.json({ success: true });
    } else {
      await setIntegrationAuthFailed({ connectionId, reason: probe.reason, actor });
      return NextResponse.json({ success: false, error: probe.reason }, { status: 200 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection failed";
    await setIntegrationAuthFailed({ connectionId, reason: message, actor });
    return NextResponse.json({ success: false, error: message }, { status: 200 });
  }
});
