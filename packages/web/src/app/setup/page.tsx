import { redirect } from "next/navigation";
import Image from "next/image";
import { isSetupComplete } from "@/lib/setup";
import { SetupForm } from "@/components/setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  const setupCompleted = await isSetupComplete();

  if (setupCompleted) {
    redirect("/");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        <Image src="/pinchy-logo.png" alt="Pinchy" width={80} height={85} priority />
        <SetupForm />
      </div>
    </div>
  );
}
