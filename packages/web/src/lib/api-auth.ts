import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession, type Session } from "@/lib/auth";

/**
 * Check auth + admin role for API routes.
 * Returns the session if the user is an admin, or a NextResponse error otherwise.
 */
export async function requireAdmin(): Promise<Session | NextResponse> {
  const session = await getSession({
    headers: await headers(),
  });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return session;
}
