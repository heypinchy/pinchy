// audit-exempt: invite claim is a self-service action by the invited user, not an admin action
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users, userGroups } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateInviteToken, claimInvite, getInviteGroupIds } from "@/lib/invites";
import { seedPersonalAgent } from "@/lib/personal-agent";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { validatePassword } from "@/lib/validate-password";
import { parseRequestBody } from "@/lib/api-validation";

const claimInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().optional(),
  password: z.string(),
});

export async function POST(request: NextRequest) {
  const parsed = await parseRequestBody(claimInviteSchema, request);
  if ("error" in parsed) return parsed.error;
  const { token, name, password } = parsed.data;

  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  const invite = await validateInviteToken(token);
  if (!invite) {
    return NextResponse.json({ error: "Invalid or expired invite link" }, { status: 410 });
  }

  if (invite.type === "reset") {
    const existingUser = invite.email
      ? await db.query.users.findFirst({ where: eq(users.email, invite.email) })
      : null;

    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Use Better Auth admin API to set password
    // setUserPassword is provided by the admin plugin but not included in the inferred API type
    await (
      auth.api as unknown as {
        setUserPassword: (opts: {
          body: { userId: string; newPassword: string };
        }) => Promise<unknown>;
      }
    ).setUserPassword({
      body: { userId: existingUser.id, newPassword: password },
    });

    if (name) {
      await db.update(users).set({ name }).where(eq(users.id, existingUser.id));
    }
    await claimInvite(invite.tokenHash, existingUser.id);

    return NextResponse.json({ success: true }, { status: 200 });
  }

  // New user invite
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const result = await auth.api.signUpEmail({
    body: { name: name.trim(), email: invite.email!, password },
  });

  if (!result?.user) {
    return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
  }

  if (invite.role !== "member") {
    await db.update(users).set({ role: invite.role }).where(eq(users.id, result.user.id));
  }

  // Assign invite groups to new user
  const groupIds = await getInviteGroupIds(invite.id);
  if (groupIds.length > 0) {
    await db
      .insert(userGroups)
      .values(groupIds.map((groupId) => ({ userId: result.user.id, groupId })));
  }

  await seedPersonalAgent(result.user.id, invite.role === "admin");
  await claimInvite(invite.tokenHash, result.user.id);
  await regenerateOpenClawConfig();

  return NextResponse.json({ success: true }, { status: 201 });
}
