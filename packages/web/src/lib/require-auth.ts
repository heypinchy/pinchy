import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function requireAuth() {
  const session = await auth();

  if (!session || typeof session !== "object" || !("user" in session) || !session.user) {
    redirect("/login");
  }

  // Validate the JWT user still exists in the database (handles stale JWTs after DB reset)
  const userId = session.user.id;
  if (userId) {
    const dbUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!dbUser) {
      redirect("/login");
    }
  }

  return session;
}
