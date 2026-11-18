// audit-exempt: users updating their own profile is a self-service action
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { parseRequestBody } from "@/lib/api-validation";
import { updateMeSchema } from "@/lib/schemas/settings";

export const PATCH = withAuth(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(updateMeSchema, request);
  if ("error" in parsed) return parsed.error;
  const { name } = parsed.data;

  await db.update(users).set({ name }).where(eq(users.id, session.user.id));

  return NextResponse.json({ success: true });
});
