import Link from "next/link";
import { headers } from "next/headers";
import { ShieldAlert } from "lucide-react";
import { isInsecureMode } from "@/lib/domain";
import { isLoopbackRequest } from "@/lib/loopback-request";

export async function InsecureBanner({ isAdmin }: { isAdmin: boolean }) {
  const insecure = await isInsecureMode();
  if (!insecure) return null;

  // On a local install over plain HTTP the warning is not just noise, it is
  // wrong: a browser already treats `http://localhost` as a secure context
  // because the traffic never leaves the machine, and "lock your domain" is
  // advice for a domain the operator does not have. A proxied instance keeps
  // its banner — see `isLoopbackRequest` for how the two are told apart.
  //
  // Both conditions matter. Over HTTPS the advice stops being empty: the lock
  // route (`POST /api/settings/domain`) gates on this exact header, and
  // settings then offers "Lock <host> & restart" for whatever host it sees,
  // localhost included. So a request that reached us over TLS keeps its banner
  // even from a loopback host — which is also what closes the nginx
  // `proxy_pass`-without-`proxy_set_header` gap, where a public instance
  // reports `localhost` and no forwarded host contradicts it.
  //
  // Reading the scheme is sound in a way that reading the other `x-forwarded-*`
  // headers is not: Next back-fills them all, but it derives `isHttps` from
  // `socket.encrypted`, so a plain-HTTP container can only ever synthesize
  // `http`. The value `https` had to come from something that terminated TLS.
  //
  // Display only. Whether auth cookies are issued `Secure` is decided in
  // `secure-cookies.ts` from the persisted domain-lock flag, untouched by this.
  const h = await headers();
  const overHttps = h.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  if (
    !overHttps &&
    isLoopbackRequest({ host: h.get("host"), forwardedHost: h.get("x-forwarded-host") })
  ) {
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
