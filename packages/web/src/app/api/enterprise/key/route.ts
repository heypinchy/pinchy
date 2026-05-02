import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/api-auth";
import { setSetting, deleteSetting } from "@/lib/settings";
import { clearLicenseCache, getLicenseStatus, isKeyFromEnv } from "@/lib/enterprise";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";

const setLicenseKeySchema = z.object({ key: z.string().min(1) });

export async function PUT(req: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  if (isKeyFromEnv()) {
    return NextResponse.json(
      {
        error:
          "License key is managed via PINCHY_ENTERPRISE_KEY environment variable. Remove it to manage the key here.",
      },
      { status: 409 }
    );
  }

  const parsed = await parseRequestBody(setLicenseKeySchema, req);
  if ("error" in parsed) return parsed.error;
  const { key } = parsed.data;

  // Save the key encrypted, clear cache, then validate via production key path
  await setSetting("enterprise_key", key, true);
  clearLicenseCache();

  const status = await getLicenseStatus();
  if (!status.active) {
    // Invalid key — roll back
    await deleteSetting("enterprise_key");
    clearLicenseCache();
    return NextResponse.json({ error: "Invalid or expired license key" }, { status: 400 });
  }

  // Audit log (don't log the key value itself)
  await appendAuditLog({
    eventType: "config.changed",
    actorType: "user",
    actorId: sessionOrError.user.id,
    detail: {
      setting: "enterprise_key",
      type: status.type,
      org: status.org,
      expiresAt: status.expiresAt?.toISOString(),
    },
    outcome: "success",
  });

  return NextResponse.json({
    enterprise: status.active,
    type: status.type ?? null,
    org: status.org ?? null,
    expiresAt: status.expiresAt?.toISOString() ?? null,
    daysRemaining: status.daysRemaining ?? null,
  });
}
