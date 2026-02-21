import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getAllSettings, setSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const all = await getAllSettings();
  const safe = all.map((s) => ({
    ...s,
    value: s.encrypted ? "••••••••" : s.value,
  }));
  return NextResponse.json(safe);
}

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const { key, value } = await request.json();
  await setSetting(key, value, key.includes("api_key"));

  appendAuditLog({
    actorType: "user",
    actorId: sessionOrError.user.id!,
    eventType: "config.changed",
    detail: { key },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
