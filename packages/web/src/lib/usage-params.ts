import { NextResponse } from "next/server";

/**
 * Parse and validate the `days` query parameter from a usage API request.
 * Returns the number of days to look back (0 = all time), or a NextResponse error.
 */
export function parseDays(daysParam: string | null): number | NextResponse {
  const raw = daysParam || "30";
  if (raw === "all" || raw === "0") return 0;
  const days = parseInt(raw, 10);
  if (isNaN(days) || days < 0) {
    return NextResponse.json({ error: "Invalid days parameter" }, { status: 400 });
  }
  return days;
}
