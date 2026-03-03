import { redirect } from "next/navigation";
import { isProviderConfigured } from "@/lib/setup";

export default async function SetupProviderLayout({ children }: { children: React.ReactNode }) {
  const providerConfigured = await isProviderConfigured();

  if (providerConfigured) {
    redirect("/");
  }

  return children;
}
