import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getLicenseStatus, isKeyFromEnv } from "@/lib/enterprise";
import { getSeatUsage } from "@/lib/seat-usage";

export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await getLicenseStatus();
  const usage = await getSeatUsage(status);
  return NextResponse.json({
    enterprise: status.active,
    type: status.type ?? null,
    org: status.org ?? null,
    expiresAt: status.expiresAt?.toISOString() ?? null,
    daysRemaining: status.daysRemaining ?? null,
    managedByEnv: isKeyFromEnv(),
    seatsUsed: usage.used,
    maxUsers: status.maxUsers,
  });
}
