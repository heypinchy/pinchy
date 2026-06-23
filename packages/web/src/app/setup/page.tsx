import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isSetupComplete } from "@/lib/setup";
import { SetupForm } from "@/components/setup-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Setup",
};

export default async function SetupPage() {
  const setupCompleted = await isSetupComplete();

  if (setupCompleted) {
    redirect("/");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pinchy-logo.svg" alt="Pinchy" width={80} height={85} />
        <SetupForm />
      </div>
    </div>
  );
}
