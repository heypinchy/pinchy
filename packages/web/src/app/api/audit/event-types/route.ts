import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { asc } from "drizzle-orm";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const rows = await db
    .selectDistinct({ eventType: auditLog.eventType })
    .from(auditLog)
    .orderBy(asc(auditLog.eventType));

  return NextResponse.json({ eventTypes: rows.map((r) => r.eventType) });
}
