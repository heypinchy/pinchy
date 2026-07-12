import type { Metadata } from "next";
import { requireAuth } from "@/lib/require-auth";
import { getVisibleAgents } from "@/lib/visible-agents";
import { SharePicker } from "@/components/share/share-picker";

export const metadata: Metadata = {
  title: "Share",
};

export default async function SharePage() {
  const session = await requireAuth();
  const userId = session?.user?.id;
  const userRole = session?.user?.role ?? "member";

  const visibleAgents = await getVisibleAgents(userId!, userRole);

  return <SharePicker agents={visibleAgents} />;
}
