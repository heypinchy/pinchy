import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { isInsecureMode } from "@/lib/domain";

export async function InsecureBanner({ isAdmin }: { isAdmin: boolean }) {
  const insecure = await isInsecureMode();
  if (!insecure) return null;

  return (
    <div
      role="alert"
      className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm text-white"
    >
      <ShieldAlert className="size-4 shrink-0" />
      <span>Your Pinchy instance is not secured. Lock your domain to enable HTTPS hardening.</span>
      {isAdmin ? (
        <Link href="/settings?tab=security" className="ml-1 font-medium underline">
          Secure your instance →
        </Link>
      ) : (
        <span className="ml-1">Contact your administrator.</span>
      )}
    </div>
  );
}
