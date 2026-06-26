import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
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
  return <NewIntegrationContent />;
}
