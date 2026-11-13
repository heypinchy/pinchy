import { deepMerge } from "./deep-merge";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `agents.defaults` keys OpenClaw 2026.8 retired. Its loader rejects them as
 * unrecognized; only `openclaw doctor` migrates them, and no Pinchy deployment
 * runs doctor. A file an earlier Pinchy wrote still carries them, and the
 * deep-merge over that file would carry them on forever.
 *
 *   - `contextTokens`: gone without a defaults-level replacement. The budget
 *     now lives only per model (`models.providers.*.models[].contextTokens`),
 *     which Pinchy already emits for every model it configures
 *     (effective-context.ts).
 *   - `memorySearch`: moved to root `memory.search` (build.ts).
 */
const RETIRED_AGENT_DEFAULTS = ["contextTokens", "memorySearch"] as const;

/**
 * `agents.defaults.<key>.agentId` references OpenClaw 2026.9 writes itself:
 * when a roster first grows past one agent, it hands the roles the sole agent
 * held implicitly (heartbeat, system agent, credential inheritance, session
 * store) to that agent by name (`materializeLegacyDefaultAgentRoles`). Pinchy
 * keeps them — they preserve what the single-agent install did — but one that
 * names an agent Pinchy has since deleted makes the next write invalid
 * ("Unknown agent id"), so it goes with the agent.
 */
const ROSTER_STAMPED_DEFAULTS = ["heartbeat", "systemAgent", "authInheritance", "sessionStore"];

function withoutStaleAgentId(value: unknown, agentIds: Set<string>): unknown {
  if (!isRecord(value)) return value;
  if (typeof value.agentId !== "string" || agentIds.has(value.agentId)) return value;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { agentId: _stale, ...rest } = value;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * The `agents` block of openclaw.json in OpenClaw 2026.9's layout.
 *
 * The roster is `agents.entries`, keyed by agent id (the `agents.list` array
 * is retired) and replaced wholesale on every regenerate, the way the list
 * array was: an agent deleted in Pinchy must not survive in the file. A roster
 * of more than one agent needs `ownership: "explicit"` — OpenClaw refuses it
 * otherwise — and a single-agent roster carries none, so the file never
 * depends on which roster came before.
 *
 * Everything else under `agents` is OpenClaw's and survives through the
 * deep-merge, minus the retired defaults and stale role stamps above.
 */
export function buildAgentsBlock(
  existingAgents: Json,
  pinchyDefaults: Json,
  entries: Record<string, Json>
): Json {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { list: _list, entries: _entries, ownership: _ownership, ...rest } = existingAgents;
  const agentIds = new Set(Object.keys(entries));

  const defaults: Json = isRecord(rest.defaults) ? { ...rest.defaults } : {};
  for (const key of RETIRED_AGENT_DEFAULTS) delete defaults[key];
  for (const key of ROSTER_STAMPED_DEFAULTS) {
    if (!(key in defaults)) continue;
    const kept = withoutStaleAgentId(defaults[key], agentIds);
    if (kept === undefined) delete defaults[key];
    else defaults[key] = kept;
  }

  const block = deepMerge({ ...rest, defaults }, { defaults: pinchyDefaults });
  if (agentIds.size > 0) block.entries = entries;
  if (agentIds.size > 1) block.ownership = "explicit";
  return block;
}

/**
 * Root `talk` is OpenClaw's (Pinchy has no voice surface), but OpenClaw 2026.9
 * stamps `talk.agentId` the same way it stamps the role defaults above. Kept
 * while that agent exists, so a regenerate does not undo OpenClaw's write;
 * dropped with the agent.
 */
export function preserveTalkBlock(existingTalk: unknown, agentIds: Set<string>): unknown {
  return withoutStaleAgentId(existingTalk, agentIds);
}
