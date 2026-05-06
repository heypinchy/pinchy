import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getLicenseStatus, isKeyFromEnv } from "@/lib/enterprise";
import { getSeatUsage } from "@/lib/seat-usage";

export const GET = withAuth(async () => {
  const status = await getLicenseStatus();
  const usage = status.active ? await getSeatUsage(status) : null;
  return NextResponse.json({
    enterprise: status.active,
    type: status.type ?? null,
    org: status.org ?? null,
    expiresAt: status.expiresAt?.toISOString() ?? null,
    daysRemaining: status.daysRemaining ?? null,
    managedByEnv: isKeyFromEnv(),
    seatsUsed: usage?.used ?? 0,
    maxUsers: status.maxUsers,
  });
});
