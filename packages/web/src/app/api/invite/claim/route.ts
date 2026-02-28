import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
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

  const passwordHash = await bcrypt.hash(password, 12);

  if (invite.type === "reset") {
    // Password reset: update existing user
    const existingUser = invite.email
      ? await db.query.users.findFirst({ where: eq(users.email, invite.email) })
      : null;

    if (!existingUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    await db
      .update(users)
      .set({ passwordHash, name: name || existingUser.name })
      .where(eq(users.id, existingUser.id));
    await claimInvite(invite.tokenHash, existingUser.id);

    return NextResponse.json({ success: true }, { status: 200 });
  }

  // New user invite
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const [user] = await db
    .insert(users)
    .values({
      email: invite.email,
      name: name.trim(),
      passwordHash,
      role: invite.role,
    })
    .returning();

  await seedPersonalAgent(user.id, invite.role === "admin");
  await claimInvite(invite.tokenHash, user.id);
  await regenerateOpenClawConfig();

  return NextResponse.json({ success: true }, { status: 201 });
}
