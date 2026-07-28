import Link from "next/link";
import { headers } from "next/headers";
import { ShieldAlert } from "lucide-react";
import { isInsecureMode } from "@/lib/domain";
import { isLoopbackRequest } from "@/lib/loopback-request";

export async function InsecureBanner({ isAdmin }: { isAdmin: boolean }) {
  const insecure = await isInsecureMode();
  if (!insecure) return null;

  // On a local install the warning is not just noise, it is wrong: a browser
  // already treats `http://localhost` as a secure context because the traffic
  // never leaves the machine, and "lock your domain" is advice for a domain the
  // operator does not have. A proxied instance keeps its banner — see
  // `isLoopbackRequest` for how the two are told apart, and for the one
  // proxy misconfiguration that defeats the distinction.
  //
  // Display only. Whether auth cookies are issued `Secure` is decided in
  // `secure-cookies.ts` from the persisted domain-lock flag, untouched by this.
  const h = await headers();
  if (isLoopbackRequest({ host: h.get("host"), forwardedHost: h.get("x-forwarded-host") })) {
    return null;
  }

  return (
    <div
      role="alert"
      data-testid="insecure-banner"
      className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm text-amber-950"
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
