import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { clearLicenseCache, isEnterprise } from "@/lib/enterprise";
import { setSetting, deleteSetting } from "@/lib/settings";

// audit-exempt: dev-only endpoint, not available in production

const DEV_ENTERPRISE_KEY =
  "eyJhbGciOiJFUzI1NiJ9.eyJ0eXBlIjoicGFpZCIsImZlYXR1cmVzIjpbImVudGVycHJpc2UiXSwiaXNzIjoiaGV5cGluY2h5LmNvbSIsInN1YiI6InBpbmNoeS1kZXYiLCJpYXQiOjE3NzM0ODUyMzQsImV4cCI6MjA4ODg0NTIzNH0.h6stBWDrHP2LnXBv18RDk9_y71_b8FvFU6IodCBJkldlLoW6uxX6P7Hr_SL8OM-jhaNqUu7BIMaTYvbqW28buA";

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
    await setSetting("enterprise_key", DEV_ENTERPRISE_KEY, true);
  }

  clearLicenseCache();

  return NextResponse.json({ enterprise: !wasEnabled });
}
