import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getAllSettings, setSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { getOrgTimezone, setOrgTimezone } from "@/lib/settings-timezone";

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

  if (key === "org.timezone") {
    const previous = await getOrgTimezone();
    try {
      await setOrgTimezone(value);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    after(() =>
      appendAuditLog({
        actorType: "user",
        actorId: sessionOrError.user.id!,
        eventType: "settings.updated",
        resource: "settings",
        detail: { timezone: { from: previous, to: value } },
        outcome: "success",
      })
    );
    return NextResponse.json({ ok: true });
  }

  await setSetting(key, value, key.includes("api_key"));

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: sessionOrError.user.id!,
      eventType: "config.changed",
      detail: { key },
      outcome: "success",
    })
  );

  return NextResponse.json({ success: true });
}
