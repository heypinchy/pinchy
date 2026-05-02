import { NextResponse, after } from "next/server";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

const VALID_PROVIDERS = Object.keys(PROVIDERS) as ProviderName[];

export const GET = withAuth(async (_req, _ctx, session) => {
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
});

export const DELETE = withAdmin(async (request, _ctx, session) => {
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

  const migratedAgents: {
    id: string;
    name: string;
    fromModel: string;
    toModel: string;
  }[] = [];
  let newDefault: ProviderName | undefined;
  const previousDefault = await getSetting("default_provider");
  const wasDefault = previousDefault === provider;

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
        migratedAgents.push({
          id: agent.id,
          name: agent.name,
          fromModel: agent.model,
          toModel: remaining.config.defaultModel,
        });
      }
    }

    // If this was the default provider, switch to a remaining one
    if (wasDefault) {
      await setSetting("default_provider", remaining.name, false);
      newDefault = remaining.name;
    }
  }

  // Regenerate config to reflect removed provider key and migrated agent models.
  // regenerateOpenClawConfig reads all state from DB and skips writing if unchanged.
  await regenerateOpenClawConfig();

  // audit's truncateDetail (lib/audit.ts) replaces the entire detail with an
  // opaque {_truncated, summary} object once over 2KB. With ~150 bytes per
  // migratedAgents entry, that triggers around 12 agents — and would silently
  // shred agentCount / wasDefault / newDefault along with it. Cap the inline
  // list at MAX_INLINE_MIGRATED so structured fields always survive in the
  // enterprise scenarios this audit exists for.
  const MAX_INLINE_MIGRATED = 10;
  const truncated = migratedAgents.length > MAX_INLINE_MIGRATED;
  const inlineMigrated = truncated ? migratedAgents.slice(0, MAX_INLINE_MIGRATED) : migratedAgents;

  // Fire audit via after() — same pattern as the sibling settings/domain route.
  // The state mutation is already complete; an audit DB blip should not turn
  // a successful provider removal into a 500 the user sees.
  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "settings.deleted",
      resource: `settings:provider:${provider}`,
      outcome: "success",
      detail: {
        name: config.name,
        provider,
        wasDefault,
        ...(newDefault !== undefined ? { newDefault } : {}),
        agentCount: migratedAgents.length,
        migratedAgents: inlineMigrated,
        ...(truncated ? { migratedAgentsTruncated: true } : {}),
      },
    })
  );

  return NextResponse.json({ success: true });
});
