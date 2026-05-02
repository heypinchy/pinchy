// audit-exempt: users changing their own password is a self-service action
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { withAuth } from "@/lib/api-auth";

export const POST = withAuth(async (request) => {
  const { currentPassword, newPassword } = await request.json();

  if (!currentPassword) {
    return NextResponse.json({ error: "Current password is required" }, { status: 400 });
  }
  if (!newPassword || newPassword.length < 8) {
    return NextResponse.json(
      { error: "New password must be at least 8 characters" },
      { status: 400 }
    );
  }

  try {
    await auth.api.changePassword({
      body: {
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      },
      headers: await headers(),
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 403 });
  }
});
