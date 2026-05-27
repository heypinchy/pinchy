// audit-exempt: initial setup runs before any users exist, no actor to audit
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdmin } from "@/lib/setup";
import { validatePassword } from "@/lib/validate-password";
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
    // Don't regenerate openclaw.json yet — Smithers' default model
    // ("anthropic/claude-sonnet-4-6", chosen by seedDefaultAgent as a
    // pre-provider fallback) would trigger OpenClaw's auto-enable for
    // anthropic, then fail to resolve its SecretRef against the still-empty
    // secrets.json and crash-loop the gateway. /api/setup/provider runs
    // next in the wizard flow, resolves Smithers' model against the picked
    // provider via resolveModelForTemplate, and regenerates openclaw.json
    // with both the agent and the matching provider in one atomic write.
    // The provider-picker UI between these two routes doesn't talk to
    // OpenClaw, so Smithers being absent from openclaw.json here is fine.
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
