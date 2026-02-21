import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireAdmin } from "@/lib/api-auth";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { writeOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

const VALID_PROVIDERS = Object.keys(PROVIDERS) as ProviderName[];

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const defaultProvider = await getSetting("default_provider");

  const providers: Record<string, { configured: boolean; hint?: string }> = {};
  for (const [name, config] of Object.entries(PROVIDERS)) {
    const value = await getSetting(config.settingsKey);
    providers[name] = {
      configured: value !== null,
      ...(value ? { hint: value.slice(-4) } : {}),
    };
  }

  return NextResponse.json({ defaultProvider, providers });
}

export async function DELETE(request: Request) {
  const adminResult = await requireAdmin();
  if (adminResult instanceof NextResponse) return adminResult;

  const body = await request.json();
  const provider = body.provider as ProviderName;

  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  const config = PROVIDERS[provider];

  // Count configured providers
  const configuredProviders: { name: ProviderName; config: typeof config }[] = [];
  for (const [name, providerConfig] of Object.entries(PROVIDERS)) {
    const value = await getSetting(providerConfig.settingsKey);
    if (value !== null) {
      configuredProviders.push({
        name: name as ProviderName,
        config: providerConfig,
      });
    }
  }

  if (configuredProviders.length <= 1) {
    return NextResponse.json(
      {
        error: "Cannot remove the last configured provider. Add another provider first.",
      },
      { status: 400 }
    );
  }

  await deleteSetting(config.settingsKey);

  // If this was the default provider, switch to another
  const currentDefault = await getSetting("default_provider");
  if (currentDefault === provider) {
    const remaining = configuredProviders.find((p) => p.name !== provider);
    if (remaining) {
      await setSetting("default_provider", remaining.name, false);

      const smithers = await db.query.agents.findFirst();
      if (smithers) {
        await db
          .update(agents)
          .set({ model: remaining.config.defaultModel })
          .where(eq(agents.id, smithers.id));
      }

      const newApiKey = await getSetting(remaining.config.settingsKey);
      if (newApiKey) {
        writeOpenClawConfig({
          provider: remaining.name,
          apiKey: newApiKey,
          model: remaining.config.defaultModel,
        });
      }
    }
  }

  return NextResponse.json({ success: true });
}
