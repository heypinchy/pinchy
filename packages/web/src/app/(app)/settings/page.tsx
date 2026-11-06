import type { Metadata } from "next";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getLicenseStatus, isKeyFromEnv } from "@/lib/enterprise";
import { deriveLicenseState, isLicenseActive } from "@/lib/license-state";
import { getSeatUsage } from "@/lib/seat-usage";
import { hasGatedConfig } from "@/lib/gated-config";
import { listAdminOnlyAgents } from "@/lib/admin-only-agents";
import { SettingsPageContent } from "@/components/settings-page-content";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const hdrs = await headers();
  const [{ error }, session, licenseStatus] = await Promise.all([
    searchParams,
    getSession({ headers: hdrs }),
    getLicenseStatus(),
  ]);
  const isAdmin = session?.user?.role === "admin";
  const usage = isAdmin ? await getSeatUsage(licenseStatus) : null;
  const state = deriveLicenseState(licenseStatus, new Date());
  const gatedConfig = isAdmin && !isLicenseActive(state) ? await hasGatedConfig(state) : false;
  // Read where the license card shows it: under an active license (agents
  // members can't see now) and on community (agents they'll lose on activation).
  const adminOnlyAgents =
    isAdmin && (isLicenseActive(state) || state === "community") ? await listAdminOnlyAgents() : [];
  return (
    <SettingsPageContent
      oauthError={error}
      isAdmin={isAdmin}
      initialLicense={
        isAdmin
          ? {
              enterprise: licenseStatus.active,
              state,
              type: licenseStatus.type ?? null,
              org: licenseStatus.org ?? null,
              expiresAt: licenseStatus.expiresAt?.toISOString() ?? null,
              paidUntil: licenseStatus.paidUntilAt?.toISOString() ?? null,
              daysRemaining: licenseStatus.daysRemaining ?? null,
              managedByEnv: isKeyFromEnv(),
              maxUsers: licenseStatus.maxUsers,
              seatsUsed: usage?.used ?? 0,
              hasGatedConfig: gatedConfig,
            }
          : undefined
      }
      initialAdminOnlyAgents={adminOnlyAgents}
    />
  );
}
