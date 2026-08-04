import { NextResponse, after } from "next/server";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { getSetting, deleteSetting } from "@/lib/settings";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { resetCache } from "@/lib/provider-models";
import { countConfiguredProviders } from "@/lib/provider-count";
import { appendAuditLog } from "@/lib/audit";
import {
  buildRemainingCandidates,
  builtInModelPrefix,
  migrateAgentsOffDeletedProvider,
  capMigratedAgents,
} from "@/lib/provider-deletion";
import { parseRequestBody } from "@/lib/api-validation";
import { deleteProviderSchema } from "@/lib/schemas/providers";

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
  // one being deleted. Built-ins-first ordering + custom `<slug>/<modelId>`
  // namespacing is single-sourced in buildRemainingCandidates (shared with the
  // custom DELETE route). Candidates are built BEFORE deleteSetting, so the
  // deleted built-in is still "configured" and must be excluded by name.
  const remainingCandidates = await buildRemainingCandidates({ excludeBuiltInName: provider });

  await deleteSetting(config.settingsKey);
  resetCache();

  const previousDefault = await getSetting("default_provider");
  const wasDefault = previousDefault === provider;

  // Provider name to model prefix mapping (ollama-local namespaces its models
  // as "ollama/"). Shared with the deletion preview so the dialog counts
  // exactly the agents this migration moves — see provider-deletion.ts.
  const providerPrefix = builtInModelPrefix(provider);

  // Shared with the custom OpenAI-compatible DELETE route: migrate orphaned
  // agents onto the first remaining candidate and reassign the default when the
  // removed provider was it (see provider-deletion.ts).
  const { migratedAgents, newDefault } = await migrateAgentsOffDeletedProvider({
    deletedPrefix: providerPrefix,
    remainingCandidates,
    wasDefault,
  });

  // Regenerate config to reflect removed provider key and migrated agent models.
  // regenerateOpenClawConfig reads all state from DB and skips writing if unchanged.
  await regenerateOpenClawConfig();

  const { inlineMigrated, truncated } = capMigratedAgents(migratedAgents);

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

  // `migratedAgents` mirrors the custom DELETE's response shape (#949): the
  // success toast confirms what actually happened ("3 agents moved to …") for
  // anyone who dismissed the confirmation dialog without reading it.
  return NextResponse.json({ success: true, migratedAgents: migratedAgents.length });
});
