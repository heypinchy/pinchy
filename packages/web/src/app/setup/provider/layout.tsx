import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isProviderConfigured } from "@/lib/setup";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Provider Setup",
};

export default async function SetupProviderLayout({ children }: { children: React.ReactNode }) {
  const providerConfigured = await isProviderConfigured();

  if (providerConfigured) {
    redirect("/");
  }

  return children;
}
