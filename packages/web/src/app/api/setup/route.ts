// audit-exempt: initial setup runs before any users exist, no actor to audit
import { NextRequest, NextResponse } from "next/server";
import { createAdmin } from "@/lib/setup";
import { validatePassword } from "@/lib/validate-password";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

export async function POST(request: NextRequest) {
  try {
    const { name, email, password } = await request.json();

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return NextResponse.json({ error: "A valid email address is required" }, { status: 400 });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const user = await createAdmin(name.trim(), email, password);
    // Write OpenClaw config with the newly created Smithers agent so OpenClaw
    // knows about it when the container restarts or the file watcher picks it up.
    await regenerateOpenClawConfig().catch((err) => {
      console.error("[setup] Failed to regenerate OpenClaw config:", err);
    });
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Setup already complete") {
      return NextResponse.json({ error: "Setup already complete" }, { status: 403 });
    }
    console.error("[setup] createAdmin failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
