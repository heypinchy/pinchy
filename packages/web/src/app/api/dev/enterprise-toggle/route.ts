import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { clearLicenseCache, isEnterprise } from "@/lib/enterprise";
import { DEV_LICENSE_TOKEN } from "@/lib/license-keys";
import { setSetting, deleteSetting } from "@/lib/settings";

// audit-exempt: dev-only endpoint, not available in production
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  // Clear env var so loadToken() falls through to DB
  delete process.env.PINCHY_ENTERPRISE_KEY;
  clearLicenseCache();

  const wasEnabled = await isEnterprise();

  if (wasEnabled) {
    await deleteSetting("enterprise_key");
  } else {
    await setSetting("enterprise_key", DEV_LICENSE_TOKEN, true);
  }

  clearLicenseCache();

  return NextResponse.json({ enterprise: !wasEnabled });
}
