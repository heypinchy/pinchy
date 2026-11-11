type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The agent OpenClaw 2026.9 assumes for a config with no roster of its own
 * (`migratePersistedImplicitMainRoster` materializes `agents.entries.main`),
 * unless `agents.ownership` is "explicit". Never one of Pinchy's agents, whose
 * ids are UUIDs: on a Pinchy install it is only ever this placeholder.
 */
export const PLACEHOLDER_AGENT_ID = "main";

/** The roster as OpenClaw reads it: keyed entries, or a list it has not migrated yet. */
function rosterEntries(config: Json): Record<string, Json> | undefined {
  const agents = isRecord(config.agents) ? config.agents : undefined;
  if (!agents) return undefined;
  if (isRecord(agents.entries)) {
    const entries: Record<string, Json> = {};
    for (const [id, entry] of Object.entries(agents.entries)) {
      entries[id] = isRecord(entry) ? entry : {};
    }
    return entries;
  }
  if (Array.isArray(agents.list)) {
    const entries: Record<string, Json> = {};
    for (const item of agents.list) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, ...entry } = item;
      entries[id] = entry;
    }
    return entries;
  }
  return undefined;
}

/** OpenClaw's roster including the implicit agent it materializes for an empty one. */
function effectiveRoster(config: Json): Record<string, Json> {
  const entries = rosterEntries(config) ?? {};
  if (Object.keys(entries).length > 0) return entries;
  const explicit = isRecord(config.agents) && config.agents.ownership === "explicit";
  return explicit ? {} : { [PLACEHOLDER_AGENT_ID]: {} };
}

const ROSTER_DROP_PREFIX =
  "Config write would drop agent roster entries without an explicit deletion: ";

/**
 * The agent ids of OpenClaw 2026.9's refusal of a write that drops agents
 * from its roster (`assertCanonicalAgentRosterRetainsEntries`), or undefined
 * for any other error. Only its own `agents.delete` may remove an agent:
 * config.apply takes no parameter that lifts the check. Pinchy replaces the
 * roster wholesale, so every deleted agent reaches OpenClaw as such a write —
 * and so does the first agent of a fresh install, which drops the implicit
 * "main" OpenClaw assumes for a file with no roster.
 */
export function parseRosterDropRejection(message: string): string[] | undefined {
  const at = message.indexOf(ROSTER_DROP_PREFIX);
  if (at < 0) return undefined;
  const ids = message
    .slice(at + ROSTER_DROP_PREFIX.length)
    .replace(/\.\s*$/, "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * `payload` with the dropped agents kept, as OpenClaw holds them: the write
 * OpenClaw accepts before `agents.delete` removes them. A roster of more than
 * one agent needs explicit ownership, which this one always is.
 *
 * It also hands `agents.defaults.authInheritance` — the agent whose auth
 * profiles the others inherit — to an agent that stays. OpenClaw's
 * agents.delete refuses that agent, and a roster write pins the role to the
 * agent a sole-agent roster held, so replacing a sole agent would otherwise
 * deadlock. Pinchy keeps no auth profiles (provider keys reach OpenClaw as
 * SecretRefs, build.ts), so the role carries nothing for it.
 */
export function retainRosterEntries(payload: Json, ocConfig: Json, ids: string[]): Json {
  const held = effectiveRoster(ocConfig);
  const agents = isRecord(payload.agents) ? payload.agents : {};
  const kept = Object.keys(rosterEntries(payload) ?? {}).filter((id) => !ids.includes(id));
  const entries: Record<string, Json> = { ...(rosterEntries(payload) ?? {}) };
  for (const id of ids) entries[id] = held[id] ?? {};
  const bridge: Json = { ...agents, ownership: "explicit", entries };
  const defaults = isRecord(agents.defaults) ? agents.defaults : {};
  const inheritance = isRecord(defaults.authInheritance) ? defaults.authInheritance : {};
  const owner = inheritance.agentId;
  if (kept.length > 0 && !(typeof owner === "string" && kept.includes(owner))) {
    bridge.defaults = { ...defaults, authInheritance: { ...inheritance, agentId: kept[0] } };
  }
  return { ...payload, agents: bridge };
}
