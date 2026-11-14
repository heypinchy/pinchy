type AgentModel = string | { primary?: string } | undefined;
type AgentRecord = { id?: string; name?: string; model?: AgentModel };

/**
 * Looks up an agent's `name` and `model` from the OpenClaw runtime config.
 *
 * OpenClaw 2026.9 keeps agents under `cfg.agents.entries`, keyed by id, and
 * migrates any `cfg.agents.list` into it on load; earlier versions only had
 * the list. Both are read, entries first. A model may carry fallbacks
 * (`{ primary, fallbacks }`); only the primary is returned.
 *
 * Used by the plugin at two different call sites — the vision API needs the
 * model, the usage reporter needs a human-readable name for the Usage
 * Dashboard. Doing both resolutions in one place prevents drift (e.g. name
 * falling back to the ID while model is correctly resolved).
 *
 * Returns `undefined` for any field that isn't present so callers can decide
 * on their own fallback (`name ?? agentId`, `model ?? undefined`, etc.).
 */
export function resolveAgentInfo(cfg: unknown, agentId: string): { name?: string; model?: string } {
  const agents = (
    cfg as { agents?: { entries?: Record<string, AgentRecord>; list?: AgentRecord[] } } | null
  )?.agents;
  const entries = agents?.entries;
  const agent =
    (entries && Object.hasOwn(entries, agentId) ? entries[agentId] : undefined) ??
    agents?.list?.find((a) => a.id === agentId);
  const model = agent?.model;
  return {
    name: agent?.name,
    model: typeof model === "string" ? model : model?.primary,
  };
}
