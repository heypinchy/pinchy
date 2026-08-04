import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { parseUsageFilter } from "@/lib/usage-params";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { desc } from "drizzle-orm";
import { csvEscape } from "@/lib/csv";

const MAX_EXPORT_ROWS = 100_000;

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  if (!(await isEnterprise())) {
    return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
  }

  const url = new URL(request.url);
  const format = url.searchParams.get("format") || "json";
  const filter = parseUsageFilter(url);
  if (filter instanceof NextResponse) return filter;
  const { where } = filter;

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
