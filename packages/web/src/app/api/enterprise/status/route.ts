import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getLicenseStatus, isKeyFromEnv } from "@/lib/enterprise";
import { deriveLicenseState, isLicenseActive } from "@/lib/license-state";
import { getSeatUsage } from "@/lib/seat-usage";
import { hasGatedConfig } from "@/lib/gated-config";

export const GET = withAuth(async () => {
  const status = await getLicenseStatus();
  const state = deriveLicenseState(status, new Date());
  const usage = status.active ? await getSeatUsage(status) : null;
  // Only relevant for the "Remove all license-gated configuration" escape
  // hatch, which exists for instances without an active license.
  const gatedConfig = isLicenseActive(state) ? false : await hasGatedConfig();
  return NextResponse.json({
    enterprise: status.active,
    state,
    type: status.type ?? null,
    org: status.org ?? null,
    expiresAt: status.expiresAt?.toISOString() ?? null,
    paidUntil: status.paidUntilAt?.toISOString() ?? null,
    daysRemaining: status.daysRemaining ?? null,
    managedByEnv: isKeyFromEnv(),
    seatsUsed: usage?.used ?? 0,
    maxUsers: status.maxUsers,
    hasGatedConfig: gatedConfig,
  });
});
