import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { setSetting } from "@/lib/settings";
import { clearLicenseCache, validateLicenseToken, isKeyFromEnv } from "@/lib/enterprise";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { setLicenseKeySchema } from "@/lib/schemas/enterprise";

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

  // Validate BEFORE writing anything. Storing first and rolling back on a bad
  // verdict looks equivalent and is not: the rollback deleted the setting
  // rather than restoring it, so an admin who pasted a typo lost the working
  // license that had been there and dropped to the community state. Nothing
  // here reads the stored key, so a rejected attempt leaves the install
  // exactly as it found it — no write, no cache eviction.
  const status = await validateLicenseToken(key);
  if (!status.active) {
    // A rejected license-activation attempt is a governance-relevant security
    // action; audit the failure (never log the key value itself).
    await appendAuditLog({
      eventType: "config.changed",
      actorType: "user",
      actorId: sessionOrError.user.id,
      detail: { setting: "enterprise_key", reason: "invalid_or_expired" },
      outcome: "failure",
      error: { message: "Invalid or expired license key" },
    });
    return NextResponse.json({ error: "Invalid or expired license key" }, { status: 400 });
  }

  // Accepted — store it encrypted and evict the cached verdict so every gate
  // re-derives against the new key.
  await setSetting("enterprise_key", key, true);
  clearLicenseCache();

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
