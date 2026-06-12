import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { UsageDashboard } from "@/components/usage-dashboard";
import { getLicenseStatus } from "@/lib/enterprise";
import { deriveLicenseState } from "@/lib/license-state";

export const metadata: Metadata = {
  title: "Usage & Costs",
};

export default async function UsagePage() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    redirect("/");
  }

  const licenseStatus = await getLicenseStatus();
  const licenseState = deriveLicenseState(licenseStatus, new Date());

  return (
    <div className="flex-1 overflow-auto p-6">
      <UsageDashboard
        isEnterprise={licenseStatus.active}
        licenseState={licenseState}
        licensePeriodEnd={
          licenseStatus.paidUntilAt?.toISOString() ?? licenseStatus.expiresAt?.toISOString() ?? null
        }
      />
    </div>
  );
}
