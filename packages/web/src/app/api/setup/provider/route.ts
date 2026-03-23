import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { validateProviderKey, PROVIDERS, type ProviderName } from "@/lib/providers";
import { getSetting, setSetting } from "@/lib/settings";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
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

  const validation = await validateProviderKey(provider, apiKey);
  if (!validation.valid) {
    if (validation.error === "invalid_key") {
      return NextResponse.json(
        { error: "Invalid API key. Please check and try again." },
        { status: 422 }
      );
    }
    if (validation.error === "network_error") {
      return NextResponse.json(
        { error: "Could not reach the provider API. Please check your network and try again." },
        { status: 502 }
      );
    }
    // provider_error (429, 5xx, etc.)
    return NextResponse.json(
      {
        error: `The provider returned an error (HTTP ${validation.status}). The key may be valid — please try again in a moment.`,
      },
      { status: 502 }
    );
  }

  const config = PROVIDERS[provider as ProviderName];

  // Check if any other providers are already configured (before saving the new one)
  let isFirstProvider = true;
  for (const [name, providerConfig] of Object.entries(PROVIDERS)) {
    if (name !== provider) {
      const existingKey = await getSetting(providerConfig.settingsKey);
      if (existingKey !== null) {
        isFirstProvider = false;
        break;
      }
    }
  }

  // Store encrypted key and default provider
  await setSetting(config.settingsKey, apiKey, true);
  await setSetting("default_provider", provider, false);

  // Only update agent model when adding the first provider
  if (isFirstProvider) {
    const smithers = await db.query.agents.findFirst();
    if (smithers) {
      await db.update(agents).set({ model: config.defaultModel }).where(eq(agents.id, smithers.id));
    }
  }

  // Regenerate full OpenClaw config (includes agent list, provider env, model defaults)
  await regenerateOpenClawConfig();
  resetCache();

  appendAuditLog({
    actorType: "user",
    actorId: sessionOrError.user.id!,
    eventType: "config.changed",
    detail: { key: "provider", provider },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
