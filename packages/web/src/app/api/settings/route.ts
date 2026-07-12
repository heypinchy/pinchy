import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import { getAllSettings, setSetting } from "@/lib/settings";
import { getOrgTimezone, setOrgTimezone, isValidIanaTimezone } from "@/lib/settings-timezone";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";

const setSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

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

  const parsed = await parseRequestBody(setSettingSchema, request);
  if ("error" in parsed) return parsed.error;
  const { key, value } = parsed.data;

  if (key === "org.timezone") {
    // Validate client input first (400). Persistence failures below are NOT
    // caught here, so a genuine DB error surfaces as a 500 rather than being
    // misreported to the client as bad input.
    if (!isValidIanaTimezone(value)) {
      return NextResponse.json({ error: `invalid IANA timezone: ${value}` }, { status: 400 });
    }
    const previous = await getOrgTimezone();
    await setOrgTimezone(value);
    // The generic branch below intentionally logs a value-less `config.changed`
    // because it also handles secret keys (api_key*), where a from/to diff would
    // leak the secret into the audit detail. The timezone is not a secret, so it
    // gets the richer `settings.updated` diff — but only when it actually changed,
    // so a no-op save doesn't spam the audit log with from===to rows.
    if (previous !== value) {
      after(() =>
        appendAuditLog({
          actorType: "user",
          actorId: sessionOrError.user.id!,
          eventType: "settings.updated",
          resource: "settings",
          detail: { changes: { timezone: { from: previous, to: value } } },
          outcome: "success",
        })
      );
    }
    return NextResponse.json({ success: true });
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
