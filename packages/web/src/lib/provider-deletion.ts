// Shared agent-migration + default-reassignment + audit-diff logic for the
// provider mutation routes (#894).
//
// Both the built-in provider DELETE (settings/providers/route.ts) and the
// custom OpenAI-compatible DELETE (settings/providers/openai-compatible/route.ts)
// must, after removing a provider: repoint every agent still pinned to the
// removed provider's model prefix onto a remaining provider's default model,
// reassign `default_provider` when the removed one was the default, and emit an
// audit whose migrated-agent diff is capped so audit's 2KB truncateDetail can
// never shred the structured fields. That logic lived inline and byte-identical
// in the built-in route; it lives here once so the custom route reuses it rather
// than copy-pasting a subtly-drifting second copy.
//
// It also owns the sibling case where a provider SURVIVES but one of its models
// is removed (a custom-provider EDIT — see repointAgentsOffRemovedModels): the
// same "an agent's pinned model no longer exists, move it to a valid one"
// invariant, minus the default-provider reassignment.

import { setSetting } from "@/lib/settings";
import { listConfiguredBuiltIns } from "@/lib/provider-count";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

/** A provider an orphaned agent can migrate onto. */
export interface RemainingCandidate {
  /** Built-in ProviderName or custom slug — also the value written to default_provider. */
  name: string;
  /** Human-readable name, for user-facing copy (#949). Never used for matching. */
  label: string;
  /** The namespaced model an agent is repointed to (e.g. `anthropic/…` or `<slug>/…`). */
  defaultModel: string;
}

/**
 * The ordered set of providers an orphaned agent can migrate onto, shared by
 * both DELETE routes so the built-ins-first ordering AND the custom-instance
 * `<slug>/<modelId>` namespacing (which must match the openclaw.json emission)
 * are single-sourced rather than byte-duplicated.
 *
 * Built-ins come first (so the all-built-ins migration path stays byte-identical
 * to before), then every custom instance. The two DELETE routes exclude the
 * just-deleted provider differently, and that is the only parameter:
 *
 * - **Built-in delete** builds candidates BEFORE removing the settings key, so
 *   the deleted built-in is still "configured" — pass `excludeBuiltInName` to
 *   skip it by name.
 * - **Custom delete** builds candidates AFTER `deleteProviderById`, so the row
 *   is already gone from `listOpenAiCompatibleProviders()` — pass nothing.
 */
export async function buildRemainingCandidates(opts?: {
  excludeBuiltInName?: string;
}): Promise<RemainingCandidate[]> {
  const excludeBuiltInName = opts?.excludeBuiltInName;
  const candidates: RemainingCandidate[] = [];
  for (const builtIn of await listConfiguredBuiltIns()) {
    if (excludeBuiltInName !== undefined && builtIn.name === excludeBuiltInName) continue;
    candidates.push({
      name: builtIn.name,
      label: builtIn.config.name,
      defaultModel: builtIn.config.defaultModel,
    });
  }
  for (const custom of await listOpenAiCompatibleProviders()) {
    // models non-empty by create schema (.min(1))
    candidates.push({
      name: custom.slug,
      label: custom.displayName,
      defaultModel: `${custom.slug}/${custom.models[0].id}`,
    });
  }
  return candidates;
}

/**
 * The model prefix a built-in provider's models carry.
 *
 * `ollama-local` is the one provider whose settings name and model namespace
 * differ: its models are emitted as `ollama/…`. Both the DELETE route (which
 * migrates agents off the prefix) and the deletion preview (#949, which counts
 * them) need this mapping, and a second copy would make the dialog promise a
 * different set of agents than the delete moves.
 */
export function builtInModelPrefix(provider: string): string {
  return provider === "ollama-local" ? "ollama/" : `${provider}/`;
}

export interface MigratedAgent {
  id: string;
  name: string;
  fromModel: string;
  toModel: string;
}

export interface MigrationResult {
  migratedAgents: MigratedAgent[];
  /** The provider `default_provider` was reassigned to, when the deleted one was default. */
  newDefault?: string;
}

/**
 * Migrate every agent whose `model` starts with `deletedPrefix` onto the first
 * remaining candidate's default model, and — when `wasDefault` — reassign
 * `default_provider` to that same candidate.
 *
 * `remainingCandidates` MUST already exclude the deleted provider and be ordered
 * built-ins-first (Task 8): the first element wins as the migration target, so
 * the ordering is the policy. With no remaining candidate nothing is migrated
 * and no default is reassigned (the last-provider guard upstream prevents this
 * from stranding agents in practice).
 */
export async function migrateAgentsOffDeletedProvider(opts: {
  deletedPrefix: string;
  remainingCandidates: RemainingCandidate[];
  wasDefault: boolean;
}): Promise<MigrationResult> {
  const { deletedPrefix, remainingCandidates, wasDefault } = opts;

  const migratedAgents: MigratedAgent[] = [];
  let newDefault: string | undefined;

  const remaining = remainingCandidates[0];
  if (remaining) {
    const allAgents = await db.query.agents.findMany();
    for (const agent of allAgents) {
      if (agent.model?.startsWith(deletedPrefix)) {
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

    if (wasDefault) {
      await setSetting("default_provider", remaining.name, false);
      newDefault = remaining.name;
    }
  }

  return { migratedAgents, newDefault };
}

/**
 * Read-only twin of `migrateAgentsOffDeletedProvider` (#949): what removing
 * `providerName` WOULD do, so the confirmation dialog can name the target
 * instead of saying "another configured provider".
 *
 * It answers with the same two facts the migration acts on — the first
 * remaining candidate, and the agents matching the deleted prefix — by calling
 * the very same `buildRemainingCandidates()`. That shared call is the point:
 * any client-side re-derivation of the built-ins-first ordering would drift and
 * make the dialog promise a target the DELETE doesn't use.
 *
 * Unlike the two DELETE routes, this runs while the provider still exists, so
 * it excludes it from its own candidate set by NAME afterwards — which covers
 * both flavours, since `RemainingCandidate.name` is the built-in name for
 * built-ins and the slug for custom instances.
 *
 * With no remaining candidate the migration moves nothing, so neither does the
 * preview: `affectedAgents` stays empty rather than promising a move that would
 * not happen (the last-provider guard rejects that delete anyway).
 */
export async function previewProviderDeletion(opts: {
  providerName: string;
  deletedPrefix: string;
}): Promise<{
  target: RemainingCandidate | null;
  affectedAgents: { id: string; name: string }[];
}> {
  const { providerName, deletedPrefix } = opts;

  const candidates = await buildRemainingCandidates();
  const target = candidates.find((candidate) => candidate.name !== providerName) ?? null;
  if (!target) return { target: null, affectedAgents: [] };

  const allAgents = await db.query.agents.findMany();
  return {
    target,
    affectedAgents: allAgents
      .filter((agent) => agent.model?.startsWith(deletedPrefix))
      .map((agent) => ({ id: agent.id, name: agent.name })),
  };
}

/**
 * Repoint every agent pinned to a model of `slug` that is NO LONGER in the
 * provider's model set onto the provider's first remaining model.
 *
 * Used when an admin EDITS a custom provider and drops a model an agent was
 * using: the agent would otherwise dangle on a `<slug>/<removed-id>` that config
 * emission no longer produces and that fails at chat time. Agents on a
 * still-present model are left untouched, and agents on other providers are
 * never considered (the `<slug>/` prefix scopes it).
 *
 * `keptModelIds` are the BARE model ids the provider still has (non-empty by the
 * upsert schema's `.min(1)`); the first is the fallback target. Unlike the
 * delete-migration, there is no `default_provider` reassignment — the provider
 * itself still exists.
 */
export async function repointAgentsOffRemovedModels(opts: {
  slug: string;
  keptModelIds: string[];
}): Promise<MigratedAgent[]> {
  const { slug, keptModelIds } = opts;
  if (keptModelIds.length === 0) return []; // defensive; schema guarantees ≥1

  const prefix = `${slug}/`;
  const kept = new Set(keptModelIds.map((id) => `${slug}/${id}`));
  const fallback = `${slug}/${keptModelIds[0]}`;

  const migrated: MigratedAgent[] = [];
  const allAgents = await db.query.agents.findMany();
  for (const agent of allAgents) {
    if (agent.model?.startsWith(prefix) && !kept.has(agent.model)) {
      await db.update(agents).set({ model: fallback }).where(eq(agents.id, agent.id));
      migrated.push({
        id: agent.id,
        name: agent.name,
        fromModel: agent.model,
        toModel: fallback,
      });
    }
  }
  return migrated;
}

// audit's truncateDetail (lib/audit.ts) replaces the entire detail with an
// opaque {_truncated, summary} object once over 2KB. With ~150 bytes per
// migratedAgents entry, that triggers around 12 agents — and would silently
// shred agentCount / wasDefault / newDefault along with it. Cap the inline list
// so the structured fields always survive in the enterprise scenarios these
// audits exist for.
export const MAX_INLINE_MIGRATED = 10;

/** Cap the migrated-agent list for inline audit detail, flagging truncation. */
export function capMigratedAgents<T>(migratedAgents: T[]): {
  inlineMigrated: T[];
  truncated: boolean;
} {
  const truncated = migratedAgents.length > MAX_INLINE_MIGRATED;
  return {
    inlineMigrated: truncated ? migratedAgents.slice(0, MAX_INLINE_MIGRATED) : migratedAgents,
    truncated,
  };
}
