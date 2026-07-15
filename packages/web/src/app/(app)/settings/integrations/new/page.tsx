import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isMcpEnabled } from "@/lib/feature-flags";
import { NewIntegrationContent } from "@/components/new-integration-content";

export const metadata: Metadata = {
  title: "Add Integration",
};

export default async function NewIntegrationPage() {
  const hdrs = await headers();
  const session = await getSession({ headers: hdrs });
  if (session?.user?.role !== "admin") {
    redirect("/settings?tab=integrations");
  }
  // Read the MCP flag here, per request, and hand it to the client tree as a
  // prop. It must not travel as a NEXT_PUBLIC_* var: that would be inlined at
  // image-build time and ignore the operator's runtime .env — see
  // lib/feature-flags.ts.
  return <NewIntegrationContent mcpEnabled={isMcpEnabled()} />;
}
