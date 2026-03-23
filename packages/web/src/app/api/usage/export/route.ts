import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { parseDays } from "@/lib/usage-params";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { desc, gte, eq, and } from "drizzle-orm";

const MAX_EXPORT_ROWS = 100_000;

/** Escape a value for CSV per RFC 4180: wrap in double quotes if it contains comma, quote, or newline. */
function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const url = new URL(request.url);
  const format = url.searchParams.get("format") || "json";
  const daysOrError = parseDays(url.searchParams.get("days"));
  if (daysOrError instanceof NextResponse) return daysOrError;
  const days = daysOrError;
  const agentId = url.searchParams.get("agentId");

  const conditions = [];
  if (days > 0) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    conditions.push(gte(usageRecords.timestamp, since));
  }
  if (agentId) {
    conditions.push(eq(usageRecords.agentId, agentId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const records = await db
    .select()
    .from(usageRecords)
    .where(where)
    .orderBy(desc(usageRecords.timestamp))
    .limit(MAX_EXPORT_ROWS);

  if (format === "csv") {
    const headers = [
      "timestamp",
      "userId",
      "agentId",
      "agentName",
      "model",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "estimatedCostUsd",
    ];
    const rows = records.map((r) =>
      headers
        .map((h) => {
          const val = r[h as keyof typeof r];
          if (val === null || val === undefined) return "";
          if (val instanceof Date) return val.toISOString();
          return csvEscape(String(val));
        })
        .join(",")
    );
    const csv = [headers.join(","), ...rows].join("\n");

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="usage-export.csv"',
      },
    });
  }

  return NextResponse.json({ records });
}
