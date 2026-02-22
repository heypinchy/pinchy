import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { validateProviderKey, PROVIDERS, type ProviderName } from "@/lib/providers";
import { setSetting } from "@/lib/settings";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";

const VALID_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google"];

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const body = await request.json();
  const { provider, apiKey } = body;

  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  if (!apiKey || typeof apiKey !== "string") {
    return NextResponse.json({ error: "API key is required" }, { status: 400 });
  }

  const isValid = await validateProviderKey(provider, apiKey);
  if (!isValid) {
    return NextResponse.json(
      { error: "Invalid API key. Please check and try again." },
      { status: 422 }
    );
  }

  const config = PROVIDERS[provider as ProviderName];

  // Store encrypted key and default provider
  await setSetting(config.settingsKey, apiKey, true);
  await setSetting("default_provider", provider, false);

  // Update Smithers agent model
  const smithers = await db.query.agents.findFirst();
  if (smithers) {
    await db.update(agents).set({ model: config.defaultModel }).where(eq(agents.id, smithers.id));
  }

  // Regenerate full OpenClaw config (includes agent list, provider env, model defaults)
  await regenerateOpenClawConfig();

  appendAuditLog({
    actorType: "user",
    actorId: sessionOrError.user.id!,
    eventType: "config.changed",
    detail: { key: "provider", provider },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
