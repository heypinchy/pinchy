import { NextRequest, NextResponse, after } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getAllSettings } from "@/lib/settings";
import { getOrgTimezone, setOrgTimezone, isValidIanaTimezone } from "@/lib/settings-timezone";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { orgSettingSchema } from "@/lib/schemas/settings";

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

  // The schema allow-lists the key (org.timezone only); every other setting
  // has a dedicated route with its own validation, side effects and audit.
  const parsed = await parseRequestBody(orgSettingSchema, request);
  if ("error" in parsed) return parsed.error;
  const { value } = parsed.data;

  // Validate client input first (400). Persistence failures below are NOT
  // caught here, so a genuine DB error surfaces as a 500 rather than being
  // misreported to the client as bad input.
  if (!isValidIanaTimezone(value)) {
    return NextResponse.json({ error: `invalid IANA timezone: ${value}` }, { status: 400 });
  }
  const previous = await getOrgTimezone();
  await setOrgTimezone(value);
  // Only log when it actually changed, so a no-op save doesn't spam the audit
  // log with from===to rows.
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
