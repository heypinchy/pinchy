import { SettingsPageContent } from "@/components/settings-page-content";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <SettingsPageContent initialTab={tab} />;
}
