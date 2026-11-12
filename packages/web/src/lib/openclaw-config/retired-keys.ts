import { buildAgentsBlock } from "./agent-roster";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Move the keys OpenClaw 2026.8/9 retired out of an `openclaw.json` an earlier
 * Pinchy wrote, into where OpenClaw now reads them.
 *
 * OpenClaw's own loader migrates `agents.list` and `agents.defaults.contextTokens`
 * in memory, but rejects the rest, and its gateway refuses to start on a file
 * that carries them ("Invalid config … run openclaw doctor"). Nothing in a
 * Pinchy deployment runs doctor, and Pinchy's first full regenerate only runs
 * once the gateway is up — so an upgraded install would never start. Pinchy
 * boots before OpenClaw (its container waits for Pinchy's healthcheck), and the
 * boot seed runs this first.
 *
 *   - root `canvasHost` → the bundled `canvas` plugin's `config.host`
 *   - root `media.ttlHours` → `attachments.ttlHours`
 *   - `agents.defaults.memorySearch` → root `memory.search`
 *   - `agents.list` → keyed `agents.entries` (`ownership: "explicit"` past one
 *     agent), dropping the per-agent `contextTokens` OpenClaw also retired
 *   - `agents.defaults.contextTokens` → dropped; the per-model budget Pinchy
 *     emits is the only one left (effective-context.ts)
 *   - binding `match.peer.kind: "dm"` → `"direct"`
 *
 * Returns the input unchanged (same reference) when there is nothing to move,
 * so the caller can tell a migration from a no-op.
 */
export function migrateRetiredOpenClawKeys(config: Json): Json {
  let next = config;
  const edit = () => {
    if (next === config) next = { ...config };
    return next;
  };

  if ("canvasHost" in config) {
    const { canvasHost, ...rest } = edit();
    const plugins = isRecord(rest.plugins) ? rest.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const canvas = isRecord(entries.canvas) ? entries.canvas : {};
    const canvasConfig = isRecord(canvas.config) ? canvas.config : {};
    const host = isRecord(canvasConfig.host) ? canvasConfig.host : {};
    const enabled = isRecord(canvasHost) ? canvasHost.enabled : undefined;
    next = {
      ...rest,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          canvas: {
            ...canvas,
            config: {
              ...canvasConfig,
              host: { ...(typeof enabled === "boolean" ? { enabled } : {}), ...host },
            },
          },
        },
      },
    };
  }

  if ("media" in config) {
    const { media, ...rest } = edit();
    const attachments = isRecord(rest.attachments) ? rest.attachments : {};
    const ttlHours = isRecord(media) ? media.ttlHours : undefined;
    next = {
      ...rest,
      attachments: { ...(typeof ttlHours === "number" ? { ttlHours } : {}), ...attachments },
    };
  }

  const agents = isRecord(config.agents) ? config.agents : undefined;
  const defaults = isRecord(agents?.defaults) ? agents.defaults : undefined;
  if (
    agents &&
    (Array.isArray(agents.list) ||
      defaults?.contextTokens !== undefined ||
      defaults?.memorySearch !== undefined)
  ) {
    const draft = edit();
    if (isRecord(defaults?.memorySearch)) {
      const memory = isRecord(draft.memory) ? draft.memory : {};
      const search = isRecord(memory.search) ? memory.search : {};
      draft.memory = { ...memory, search: { ...defaults.memorySearch, ...search } };
    }
    draft.agents = buildAgentsBlock(agents, {}, rosterOf(agents));
  }

  if (Array.isArray(config.bindings) && config.bindings.some(hasDmPeer)) {
    edit().bindings = config.bindings.map((binding) => {
      if (!hasDmPeer(binding)) return binding;
      const match = binding.match as Json;
      return { ...binding, match: { ...match, peer: { ...(match.peer as Json), kind: "direct" } } };
    });
  }

  return next;
}

function rosterOf(agents: Json): Record<string, Json> {
  if (!Array.isArray(agents.list))
    return isRecord(agents.entries) ? (agents.entries as Record<string, Json>) : {};
  const entries: Record<string, Json> = {};
  for (const agent of agents.list) {
    if (!isRecord(agent) || typeof agent.id !== "string") continue;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, contextTokens: _retired, ...entry } = agent;
    entries[id] = entry;
  }
  return entries;
}

function hasDmPeer(binding: unknown): binding is Json {
  if (!isRecord(binding) || !isRecord(binding.match)) return false;
  const peer = binding.match.peer;
  return isRecord(peer) && peer.kind === "dm";
}
