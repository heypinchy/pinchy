// audit-exempt: read-only badge endpoint
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";

export const GET = withAdmin(async () => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(integrationConnections)
    .where(eq(integrationConnections.status, "auth_failed"));
  return NextResponse.json({ authFailedCount: row?.count ?? 0 });
});
