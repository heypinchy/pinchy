// audit-exempt: initial setup runs before any users exist, no actor to audit
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdmin } from "@/lib/setup";
import { validatePassword } from "@/lib/validate-password";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { markOpenClawConfigReady } from "@/lib/openclaw-config-ready";
import { parseRequestBody } from "@/lib/api-validation";

const setupSchema = z.object({
  name: z
    .string()
    .min(1)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, "Name is required"),
  email: z.string().email("A valid email address is required"),
  password: z.string(),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseRequestBody(setupSchema, request);
    if ("error" in parsed) return parsed.error;
    const { name, email, password } = parsed.data;

    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const user = await createAdmin(name, email, password);
    // Write OpenClaw config with the newly created Smithers agent so OpenClaw
    // knows about it when the container restarts or the file watcher picks it up.
    // If this fails, surface the error: the admin record was created, but the
    // user would otherwise see a confusing "agent unavailable" screen next.
    try {
      await regenerateOpenClawConfig();
    } catch (err) {
      console.error("[setup] Failed to regenerate OpenClaw config:", err);
      return NextResponse.json(
        { error: "OpenClaw config write failed; check server logs and retry setup." },
        { status: 500 }
      );
    }
    markOpenClawConfigReady();
    return NextResponse.json(user, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Setup already complete") {
      return NextResponse.json({ error: "Setup already complete" }, { status: 403 });
    }
    console.error("[setup] createAdmin failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
