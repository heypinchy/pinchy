// audit-exempt: users editing their own context is a self-service action
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { syncUserContextToWorkspaces } from "@/lib/context-sync";

export const GET = withAuth(async (_req, _ctx, session) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  return NextResponse.json({ content: user?.context ?? "" });
});

export const PUT = withAuth(async (request, _ctx, session) => {
  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  await db.update(users).set({ context: content }).where(eq(users.id, session.user.id));

  await syncUserContextToWorkspaces(session.user.id);

  return NextResponse.json({ success: true });
});
