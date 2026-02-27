import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { syncUserContextToWorkspaces } from "@/lib/context-sync";
import { getSetting } from "@/lib/settings";
import { restartState } from "@/server/restart-state";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId } = await params;
  const { content } = await request.json();

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  await db.update(users).set({ context: content }).where(eq(users.id, userId));
  await syncUserContextToWorkspaces(userId);
  restartState.notifyRestart();

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
