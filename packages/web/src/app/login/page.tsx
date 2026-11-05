import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isSafeReturnTo } from "@/lib/return-to";
import LoginForm from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  // Same check `requireAuth` uses to bounce an anonymous visitor here, so the
  // two cannot disagree: a stale or invalid cookie yields no session.user, the
  // form renders, and `/` -> `/login` -> `/` cannot loop.
  const session = await getSession({ headers: await headers() });

  if (session?.user) {
    const { returnTo } = await searchParams;
    const target = typeof returnTo === "string" && isSafeReturnTo(returnTo) ? returnTo : "/";
    redirect(target);
  }

  return <LoginForm />;
}
