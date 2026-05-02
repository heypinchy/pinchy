import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import { getAllSettings, setSetting } from "@/lib/settings";
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
