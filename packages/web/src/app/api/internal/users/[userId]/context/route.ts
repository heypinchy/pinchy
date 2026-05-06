// audit-exempt: internal endpoint called by OpenClaw plugin (Smithers), not a user-facing action
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { syncUserContextToWorkspaces } from "@/lib/context-sync";
import { getSetting } from "@/lib/settings";
import { parseRequestBody } from "@/lib/api-validation";

const internalUserContextSchema = z.object({ content: z.string() });

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId } = await params;
  const parsed = await parseRequestBody(internalUserContextSchema, request);
  if ("error" in parsed) return parsed.error;
  const { content } = parsed.data;

  await db.update(users).set({ context: content }).where(eq(users.id, userId));
  await syncUserContextToWorkspaces(userId);

  // Determine if onboarding is complete
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  let onboardingComplete = true;
  if (user?.role === "admin") {
    const orgContext = await getSetting("org_context");
    onboardingComplete = orgContext !== null;
  }

  return NextResponse.json({ success: true, onboardingComplete });
}
