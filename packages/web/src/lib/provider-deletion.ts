// Shared agent-migration + default-reassignment + audit-diff logic for the two
// provider DELETE routes (#894).
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

import { setSetting } from "@/lib/settings";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

/** A provider an orphaned agent can migrate onto. */
export interface RemainingCandidate {
  /** Built-in ProviderName or custom slug — also the value written to default_provider. */
  name: string;
  /** The namespaced model an agent is repointed to (e.g. `anthropic/…` or `<slug>/…`). */
  defaultModel: string;
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
