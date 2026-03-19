import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { SettingsPageContent } from "@/components/settings-page-content";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ tab }, session] = await Promise.all([
    searchParams,
    getSession({ headers: await headers() }),
  ]);
  const isAdmin = session?.user?.role === "admin";
  return <SettingsPageContent initialTab={tab} isAdmin={isAdmin} />;
}
