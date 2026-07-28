import { z } from "zod";

// Shared contract for the provider-removal preflight (#949).
//
// The removal dialog must name the migration target ("3 agents will be moved to
// Anthropic (claude-…)") instead of the vague "another configured provider".
// The ordering policy that PICKS that target lives in
// `buildRemainingCandidates()` (provider-deletion.ts) and must NOT be
// re-derived in the client: a second copy would drift, and the dialog would
// then promise one target while the DELETE performs another — confidently
// wrong, which is worse than vague. Hence a read-only preflight route, and this
// module as the single place its query + response shape are declared.

/** `GET /api/settings/providers/deletion-preview?provider=<nameOrSlug>`. */
export const deletionPreviewQuerySchema = z.object({
  /** A built-in `ProviderName` or a custom OpenAI-compatible provider's slug. */
  provider: z.string().min(1),
});

export type DeletionPreviewQuery = z.infer<typeof deletionPreviewQuerySchema>;

/** An agent currently pinned to a model of the provider being removed. */
export interface AffectedAgent {
  id: string;
  name: string;
}

export interface DeletionPreviewResponse {
  /** Built-in name or custom slug every affected agent is migrated onto. */
  targetProvider: string | null;
  /** Human-readable name of that provider, for the dialog copy. */
  targetProviderLabel: string | null;
  /** The namespaced model written to every affected agent (`anthropic/…`). */
  targetModel: string | null;
  affectedAgents: AffectedAgent[];
}
