import type { Metadata } from "next";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getLicenseStatus, isKeyFromEnv } from "@/lib/enterprise";
import { SettingsPageContent } from "@/components/settings-page-content";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const hdrs = await headers();
  const [{ tab }, session, licenseStatus] = await Promise.all([
    searchParams,
    getSession({ headers: hdrs }),
    getLicenseStatus(),
  ]);
  const isAdmin = session?.user?.role === "admin";
  return (
    <SettingsPageContent
      initialTab={tab}
      isAdmin={isAdmin}
      initialLicense={
        isAdmin
          ? {
              enterprise: licenseStatus.active,
              type: licenseStatus.type ?? null,
              org: licenseStatus.org ?? null,
              expiresAt: licenseStatus.expiresAt?.toISOString() ?? null,
              daysRemaining: licenseStatus.daysRemaining ?? null,
              managedByEnv: isKeyFromEnv(),
            }
          : undefined
      }
    />
  );
}
