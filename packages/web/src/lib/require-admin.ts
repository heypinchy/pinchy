import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";

export async function requireAdmin() {
  const session = await getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    redirect("/login");
  }

  if (session.user.role !== "admin") {
    redirect("/");
  }

  return session;
}
