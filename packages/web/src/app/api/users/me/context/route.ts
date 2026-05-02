// audit-exempt: users editing their own context is a self-service action
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { syncUserContextToWorkspaces } from "@/lib/context-sync";
import { parseRequestBody } from "@/lib/api-validation";

const updateContextSchema = z.object({
  content: z.string(),
});

export const GET = withAuth(async (_req, _ctx, session) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
  });

  return NextResponse.json({ content: user?.context ?? "" });
});

export const PUT = withAuth(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(updateContextSchema, request);
  if ("error" in parsed) return parsed.error;
  const { content } = parsed.data;

  await db.update(users).set({ context: content }).where(eq(users.id, session.user.id));

  await syncUserContextToWorkspaces(session.user.id);

  return NextResponse.json({ success: true });
});
