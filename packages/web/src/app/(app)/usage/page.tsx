import { getSession } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { UsageDashboard } from "@/components/usage-dashboard";

export default async function UsagePage() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user || session.user.role !== "admin") {
    redirect("/");
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <UsageDashboard />
    </div>
  );
}
