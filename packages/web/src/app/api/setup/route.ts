// audit-exempt: initial setup runs before any users exist, no actor to audit
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdmin } from "@/lib/setup";
import { validatePassword } from "@/lib/validate-password";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { markOpenClawConfigReady, isOpenClawConfigReady } from "@/lib/openclaw-config-ready";
import { parseRequestBody } from "@/lib/api-validation";

// Coalesces concurrent config-recovery retries into a single regeneration.
// The recovery path is reachable without auth (the admin already exists), so a
// flood of POSTs in the transient "admin exists, config not ready" window would
// otherwise each kick off a regenerateOpenClawConfig() — an I/O-bound
// resource-exhaustion vector. While one regeneration is in flight, later
// requests await it instead of starting their own. Module-scoped because a
// Next.js route module is a per-process singleton.
let recoveryInFlight: Promise<void> | null = null;

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
      // The admin already exists. If the config was never written (a prior setup
      // POST created the admin + agent but its regenerate threw), let the retry
      // complete the config step in-process instead of dead-ending at 403 until
      // a process restart re-runs the boot-time regenerate.
      if (!isOpenClawConfigReady()) {
        try {
          // Start a regeneration only if none is already running; concurrent
          // retries share the same in-flight promise. Cleared on settle so a
          // genuine retry after a failure can start a fresh attempt.
          if (!recoveryInFlight) {
            recoveryInFlight = regenerateOpenClawConfig()
              .then(() => {
                markOpenClawConfigReady();
              })
              .finally(() => {
                recoveryInFlight = null;
              });
          }
          await recoveryInFlight;
          return NextResponse.json({ recovered: true }, { status: 200 });
        } catch (regenErr) {
          console.error("[setup] config recovery regenerate failed:", regenErr);
          return NextResponse.json(
            { error: "OpenClaw config write failed; check server logs and retry setup." },
            { status: 500 }
          );
        }
      }
      return NextResponse.json({ error: "Setup already complete" }, { status: 403 });
    }
    console.error("[setup] createAdmin failed:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
