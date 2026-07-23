import { NextResponse, after } from "next/server";
import { z } from "zod";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { countConfiguredProviders } from "@/lib/provider-count";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { parseRequestBody } from "@/lib/api-validation";

const VALID_PROVIDERS = Object.keys(PROVIDERS) as ProviderName[];

const deleteProviderSchema = z.object({
  provider: z.enum(VALID_PROVIDERS as [ProviderName, ...ProviderName[]]),
});

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
  const parsed = await parseRequestBody(deleteProviderSchema, request);
  if ("error" in parsed) return parsed.error;
  const { provider } = parsed.data;

  const config = PROVIDERS[provider];

  // A single custom OpenAI-compatible instance counts as a valid sole provider,
  // so this count spans built-ins + custom instances (see provider-count.ts).
  const totalConfigured = await countConfiguredProviders();
  if (totalConfigured <= 1) {
    return NextResponse.json(
      {
        error: "Cannot remove the last configured provider. Add another provider first.",
      },
      { status: 400 }
    );
  }

  // Build the set of providers an orphaned agent can migrate onto, EXCLUDING the
  // one being deleted. Built-ins come first (so the all-built-ins path stays
  // byte-identical to before), then every custom instance. Each candidate is
  // reduced to the two things migration needs: a `name` (built-in ProviderName
  // or custom slug — also the value written to default_provider) and the
  // `defaultModel` an agent is repointed to. A custom instance's default model
  // is its first persisted model, namespaced `<slug>/<modelId>` to match the
  // openclaw.json emission. `models` is guaranteed non-empty by the create schema.
  const remainingCandidates: { name: string; defaultModel: string }[] = [];
  for (const [name, providerConfig] of Object.entries(PROVIDERS)) {
    if (name === provider) continue;
    const value = await getSetting(providerConfig.settingsKey);
    if (value !== null) {
      remainingCandidates.push({ name, defaultModel: providerConfig.defaultModel });
    }
  }
  for (const custom of await listOpenAiCompatibleProviders()) {
    remainingCandidates.push({
      name: custom.slug,
      defaultModel: `${custom.slug}/${custom.models[0].id}`,
    });
  }

  await deleteSetting(config.settingsKey);
  resetCache();

  const migratedAgents: {
    id: string;
    name: string;
    fromModel: string;
    toModel: string;
  }[] = [];
  let newDefault: string | undefined;
  const previousDefault = await getSetting("default_provider");
  const wasDefault = previousDefault === provider;

  const remaining = remainingCandidates[0];
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
          .set({ model: remaining.defaultModel })
          .where(eq(agents.id, agent.id));
        migratedAgents.push({
          id: agent.id,
          name: agent.name,
          fromModel: agent.model,
          toModel: remaining.defaultModel,
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
