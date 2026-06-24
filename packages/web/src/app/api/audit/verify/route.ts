import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { verifyIntegrity } from "@/lib/audit";

export async function GET(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const url = new URL(request.url);
  const fromIdRaw = url.searchParams.get("fromId");
  const toIdRaw = url.searchParams.get("toId");

  // Guard against parseInt → NaN reaching the SQL id bound (drizzle serializes
  // NaN and Postgres rejects it → unhandled 500). Reject with a 400 instead,
  // mirroring the /api/audit route hardening.
  const fromId = fromIdRaw ? parseInt(fromIdRaw, 10) : undefined;
  if (fromIdRaw && Number.isNaN(fromId)) {
    return NextResponse.json({ error: "Invalid 'fromId'" }, { status: 400 });
  }
  const toId = toIdRaw ? parseInt(toIdRaw, 10) : undefined;
  if (toIdRaw && Number.isNaN(toId)) {
    return NextResponse.json({ error: "Invalid 'toId'" }, { status: 400 });
  }

  const result = await verifyIntegrity(fromId, toId);

  return NextResponse.json(result);
}
