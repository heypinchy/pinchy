import type { Metadata } from "next";
import { AgentSettingsPageContent } from "@/components/agent-settings-page-content";
import { isMcpEnabled } from "@/lib/feature-flags";

export const metadata: Metadata = {
  title: "Agent Settings",
};

export default async function AgentSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  // Server-side flag check, passed down as a prop (main's isEnterprise
  // pattern — see app/(app)/usage/page.tsx) rather than read via
  // NEXT_PUBLIC_*/process.env inside the "use client" settings tree.
  return <AgentSettingsPageContent initialTab={tab} mcpEnabled={isMcpEnabled()} />;
}
