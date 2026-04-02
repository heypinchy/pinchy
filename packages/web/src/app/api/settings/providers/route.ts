// audit-exempt: provider removal is a settings change, audit logging planned for a future PR
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { requireAdmin } from "@/lib/api-auth";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

const VALID_PROVIDERS = Object.keys(PROVIDERS) as ProviderName[];

export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isAdmin = session.user.role === "admin";
  const defaultProvider = await getSetting("default_provider");

  const providers: Record<string, { configured: boolean; hint?: string }> = {};
  for (const [name, config] of Object.entries(PROVIDERS)) {
    const value = await getSetting(config.settingsKey);
    const providerDef = PROVIDERS[name as ProviderName];
    const isUrlProvider = providerDef?.authType === "url";
    providers[name] = {
      configured: value !== null,
      ...(value && isAdmin ? { hint: isUrlProvider ? value : value.slice(-4) } : {}),
    };
  }

  return NextResponse.json({ defaultProvider, providers });
}

export async function DELETE(request: Request) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

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
  resetCache();

  const remaining = configuredProviders.find((p) => p.name !== provider);
  if (remaining) {
    // Migrate all agents using the removed provider to the remaining provider's default model
    const allAgents = await db.query.agents.findMany();
    // Provider name to model prefix mapping
    // ollama-local uses "ollama/" as model prefix, not "ollama-local/"
    const providerPrefix = provider === "ollama-local" ? "ollama/" : `${provider}/`;
    for (const agent of allAgents) {
      if (agent.model?.startsWith(providerPrefix)) {
        await db
          .update(agents)
          .set({ model: remaining.config.defaultModel })
          .where(eq(agents.id, agent.id));
      }
    }

    // If this was the default provider, switch to a remaining one
    const currentDefault = await getSetting("default_provider");
    if (currentDefault === provider) {
      await setSetting("default_provider", remaining.name, false);
    }
  }

  // Regenerate config to reflect removed provider key and migrated agent models.
  // regenerateOpenClawConfig reads all state from DB and skips writing if unchanged.
  await regenerateOpenClawConfig();

  return NextResponse.json({ success: true });
}
