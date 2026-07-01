// audit-exempt: read-only badge endpoint
import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { countIntegrationHealth } from "@/lib/integrations/connection-health";

export const GET = withAdmin(async () => {
  // `cannotDecrypt` is not a DB status — it is derived by attempting to decrypt
  // each row's credentials (a row written under a different ENCRYPTION_KEY is
  // unreadable). That requires loading the rows and running the same masking
  // step `GET /api/integrations` uses, so we count in memory instead of via a
  // filtered SQL count. Connection counts are tiny (single digits), so the cost
  // is negligible; the shared helper keeps the derivation identical to the list.
  const connections = await db
    .select({
      type: integrationConnections.type,
      credentials: integrationConnections.credentials,
      status: integrationConnections.status,
    })
    .from(integrationConnections);

  const counts = countIntegrationHealth(connections, decrypt);
  return NextResponse.json(counts);
});
