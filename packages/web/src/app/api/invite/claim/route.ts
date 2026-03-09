import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateInviteToken, claimInvite } from "@/lib/invites";
import { seedPersonalAgent } from "@/lib/personal-agent";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { validatePassword } from "@/lib/validate-password";

export async function POST(request: NextRequest) {
  const { token, name, password } = await request.json();

  if (!token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }
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

  await seedPersonalAgent(result.user.id, invite.role === "admin");
  await claimInvite(invite.tokenHash, result.user.id);
  await regenerateOpenClawConfig();

  return NextResponse.json({ success: true }, { status: 201 });
}
