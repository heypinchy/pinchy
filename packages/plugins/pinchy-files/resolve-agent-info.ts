/**
 * Looks up an agent's `name` and `model` from the OpenClaw runtime config
 * (`cfg.agents.list`).
 *
 * Used by the plugin at two different call sites — the vision API needs the
 * model, the usage reporter needs a human-readable name for the Usage
 * Dashboard. Doing both resolutions in one place prevents drift (e.g. name
 * falling back to the ID while model is correctly resolved).
 *
 * Returns `undefined` for any field that isn't present so callers can decide
 * on their own fallback (`name ?? agentId`, `model ?? undefined`, etc.).
 */
export function resolveAgentInfo(
  cfg: unknown,
  agentId: string
): { name?: string; model?: string } {
  const agents = (cfg as { agents?: { list?: Array<{ id?: string; name?: string; model?: string }> } } | null)
    ?.agents?.list;
  const agent = agents?.find((a) => a.id === agentId);
  return {
    name: agent?.name,
    model: agent?.model,
  };
}
