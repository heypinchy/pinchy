import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { isSafeReturnTo } from "@/lib/return-to";
import LoginForm from "./login-form";
import { SignedInCard } from "./signed-in-card";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  // Same check `requireAuth` uses to send an anonymous visitor here, so the
  // two cannot disagree: a stale or invalid cookie yields no session.user and
  // the form renders.
  const session = await getSession({ headers: await headers() });

  if (session?.user) {
    // Asked, never redirected: see SignedInCard for why (#1275).
    const { returnTo } = await searchParams;
    const continueHref = typeof returnTo === "string" && isSafeReturnTo(returnTo) ? returnTo : "/";
    return (
      <SignedInCard
        name={session.user.name}
        email={session.user.email}
        continueHref={continueHref}
      />
    );
  }

  return <LoginForm />;
}
