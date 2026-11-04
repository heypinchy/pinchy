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
import { refusedBaseUrlReasons } from "@/lib/openai-compatible-stored-url";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

/** A provider an orphaned agent can migrate onto. */
export interface RemainingCandidate {
  /** Built-in ProviderName or custom slug — also the value written to default_provider. */
  name: string;
  /** Human-readable name, for user-facing copy (#949). Never used for matching. */
  label: string;
  /** The namespaced model an agent is repointed to (e.g. `anthropic/…` or `<slug>/…`). */
  defaultModel: string;
}

/** The DELETE routes' answer when nothing else is configured at all. */
export const LAST_CONFIGURED_PROVIDER_ERROR =
  "Cannot remove the last configured provider. Add another provider first.";

/**
 * The DELETE routes' answer when other providers are configured but none of
 * them is usable — every remaining one is a custom provider whose base URL the
 * SSRF guard refuses. Deleting would leave agents (and the default) nowhere to
 * go, so the delete is refused before anything changes. The plain "last
 * configured provider" message stays for the case with nothing else configured.
 */
export const LAST_USABLE_PROVIDER_ERROR =
  "Cannot remove the last usable provider. Every other configured provider has a base URL " +
  "that is now refused, so agents could not be moved onto it. Change one of those URLs or " +
  "add another provider first.";

/**
 * The same refusal when the provider being removed is refused ITSELF — e.g.
 * two custom LAN providers both refused, no built-in. "The last usable
 * provider" would be false there: the one being removed was never usable.
 */
export const NO_USABLE_TARGET_FOR_REFUSED_PROVIDER_ERROR =
  "No usable provider would remain to move this provider's agents onto. " +
  "Add or fix another provider first.";

/** `detail.reason` of the `provider_delete_refused_no_usable_target` audit. */
export type NoUsableTargetReason = "last_usable_provider" | "provider_itself_refused";

/**
 * Which "no usable provider would remain" refusal applies, as the error both
 * the DELETE routes and the deletion preview answer with (word for word) and
 * the `reason` the DELETE's audit records.
 *
 * `removedCustom` is the custom provider being removed; a built-in passes
 * nothing, because a built-in is never refused (buildRemainingCandidates
 * includes every configured one). Only called on the refusal path, so the
 * extra SSRF verdict costs nothing on an ordinary removal.
 */
export async function noUsableTargetRefusal(removedCustom?: {
  slug: string;
  baseUrl: string;
}): Promise<{ error: string; reason: NoUsableTargetReason }> {
  const removedIsRefused =
    removedCustom !== undefined &&
    (await refusedBaseUrlReasons([removedCustom])).has(removedCustom.slug);
  return removedIsRefused
    ? { error: NO_USABLE_TARGET_FOR_REFUSED_PROVIDER_ERROR, reason: "provider_itself_refused" }
    : { error: LAST_USABLE_PROVIDER_ERROR, reason: "last_usable_provider" };
}

/**
 * The ordered set of providers an orphaned agent can migrate onto, shared by
 * both DELETE routes so the built-ins-first ordering AND the custom-instance
 * `<slug>/<modelId>` namespacing (which must match the openclaw.json emission)
 * are single-sourced rather than byte-duplicated.
 *
 * Built-ins come first (so the all-built-ins migration path stays byte-identical
 * to before), then every custom instance whose saved base URL the SSRF guard
 * allows. Both DELETE routes build this BEFORE they remove anything — the
 * result is also their "is a usable provider left?" guard — so each excludes
 * the provider it is about to delete:
 *
 * - **Built-in delete** passes `excludeBuiltInName`.
 * - **Custom delete** passes `excludeCustomId` (the route only knows the row id).
 *
 * A custom provider whose base URL is refused is left out: config emission
 * points it at `REFUSED_BASE_URL` with no key (openai-compatible-stored-url.ts),
 * so every agent moved onto it would fail, and making it `default_provider`
 * would hand it what `PATCH /api/settings/providers/default` refuses to. The
 * verdict is one batch call — each host looked up once, each lookup bounded by
 * the guard's timeout, and an unresolvable name allowed (fail open), exactly as
 * emission decides it.
 */
export async function buildRemainingCandidates(opts?: {
  excludeBuiltInName?: string;
  excludeCustomId?: string;
}): Promise<RemainingCandidate[]> {
  const { excludeBuiltInName, excludeCustomId } = opts ?? {};
  const candidates: RemainingCandidate[] = [];
  for (const builtIn of await listConfiguredBuiltIns()) {
    if (excludeBuiltInName !== undefined && builtIn.name === excludeBuiltInName) continue;
    candidates.push({
      name: builtIn.name,
      label: builtIn.config.name,
      defaultModel: builtIn.config.defaultModel,
    });
  }
  const customs = (await listOpenAiCompatibleProviders()).filter(
    (custom) => excludeCustomId === undefined || custom.id !== excludeCustomId
  );
  const refused = customs.length > 0 ? await refusedBaseUrlReasons(customs) : new Map();
  for (const custom of customs) {
    if (refused.has(custom.slug)) continue;
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
 * and no default is reassigned — both DELETE routes refuse that case up front
 * ({@link noUsableTargetRefusal}), so it does not strand agents in practice.
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
 * built-ins and the slug for custom instances. That one exclusion can stand in
 * for the DELETEs' two only because the namespaces are disjoint:
 * `RESERVED_PROVIDER_SLUGS` (openai-compatible-slug.ts) keeps a custom slug
 * from ever equalling a built-in name, so no candidate is dropped by accident.
 * Its "reserves every built-in provider name" test guards that.
 *
 * With no remaining candidate the migration moves nothing, so neither does the
 * preview: `affectedAgents` stays empty rather than promising a move that would
 * not happen (the DELETE refuses that case anyway). A custom provider whose
 * base URL is refused is never the target, for the same reason it is never the
 * migration's.
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
      migrated.push({
        id: agent.id,
        name: agent.name,
        fromModel: agent.model,
        toModel: fallback,
      });
    }
  }

  // Single batched UPDATE instead of one per affected agent.
  if (migrated.length > 0) {
    await db
      .update(agents)
      .set({ model: fallback })
      .where(
        inArray(
          agents.id,
          migrated.map((a) => a.id)
        )
      );
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
