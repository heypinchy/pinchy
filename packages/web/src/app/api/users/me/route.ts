// audit-exempt: users updating their own profile is a self-service action
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export const PATCH = withAuth(async (request, _ctx, session) => {
  const { name } = await request.json();

  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  await db.update(users).set({ name: name.trim() }).where(eq(users.id, session.user.id));

  return NextResponse.json({ success: true });
});
