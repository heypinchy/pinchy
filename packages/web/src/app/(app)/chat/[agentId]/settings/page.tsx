import { AgentSettingsPageContent } from "@/components/agent-settings-page-content";

export default async function AgentSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <AgentSettingsPageContent initialTab={tab} />;
}
