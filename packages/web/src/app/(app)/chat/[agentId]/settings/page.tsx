import type { Metadata } from "next";
import { AgentSettingsPageContent } from "@/components/agent-settings-page-content";

export const metadata: Metadata = {
  title: "Agent Settings",
};

export default function AgentSettingsPage() {
  return <AgentSettingsPageContent />;
}
