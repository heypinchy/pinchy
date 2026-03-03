import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { desc, eq, and, gte, lte } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  const eventType = url.searchParams.get("eventType");
  const actorId = url.searchParams.get("actorId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const conditions = [];
  if (eventType) conditions.push(eq(auditLog.eventType, eventType));
  if (actorId) conditions.push(eq(auditLog.actorId, actorId));
  if (from) conditions.push(gte(auditLog.timestamp, new Date(from)));
  if (to) {
    const toDate = new Date(to);
    if (!to.includes("T") && !to.includes(" ")) toDate.setUTCHours(23, 59, 59, 999);
    conditions.push(lte(auditLog.timestamp, toDate));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const entries = await db.select().from(auditLog).where(where).orderBy(desc(auditLog.timestamp));

  const header = "id,timestamp,actorType,actorId,eventType,resource,detail";
  const rows = entries.map((e) => {
    const detail = e.detail ? JSON.stringify(e.detail).replace(/"/g, '""') : "";
    return `${e.id},${e.timestamp.toISOString()},${e.actorType},${e.actorId},${e.eventType},${e.resource ?? ""},"${detail}"`;
  });

  const csv = [header, ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
