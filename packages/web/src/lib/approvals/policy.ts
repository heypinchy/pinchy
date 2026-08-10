import { TOOL_REGISTRY } from "@/lib/tool-registry";
import type { AgentPluginConfig } from "@/db/schema";
import type { CallResource } from "@/lib/approvals/call-models";

/**
 * What an admin decided about one tool, or one (tool, model) cell.
 *
 * Deliberately two values and not three. The UI shows three states per cell
 * (✘ off · ! ask · ✔ allow), but "off" is not stored here — it is the absence
 * of the tool from `allowedTools`, which is what gets emitted into OpenClaw's
 * `tools.allow` and is therefore the boundary the runtime actually enforces.
 * Storing "off" twice would let the two copies disagree, and the copy the
 * runtime does not read would be the one an admin was looking at.
 */
export type ConfirmSetting = "confirm" | "allow";

/**
 * Flat keys, optionally suffixed with the resource the call touches:
 *
 *   { "odoo_delete": "confirm", "odoo_delete:note.note": "allow" }
 *
 * The suffix carries every shape we have without a second dimension: for Odoo
 * it is the model, for email/files/KB there is none, and MCP tools already
 * carry their server in the name (`<serverKey>__<tool>`, #1134).
 */
export type ConfirmMap = Record<string, ConfirmSetting>;

const KEY_SEPARATOR = ":";

/**
 * The confirmation policy for an agent, normalized.
 *
 * Reads the pre-#1133 `confirmTools: string[]` when no map has been written
 * yet. That fallback is not politeness — it is the read side of a storage
 * switch, and AGENTS.md § "Test Migrations Against Pre-Existing Data" exists
 * for exactly this: every agent whose admin turned confirmation on before
 * #1133 carries the old key, and without the fallback the map comes back
 * empty, the gate allows, and a policy an admin set stops applying silently.
 * A security control that fails this way looks indistinguishable from one that
 * works.
 *
 * The fallback keys on `confirm` being ABSENT, not on it being empty. `{}` is
 * an admin who migrated and gated nothing; falling back there would resurrect
 * a policy they deliberately cleared. Writing always emits the new shape, so
 * an agent converges the first time anyone saves it.
 */
export function getConfirmMap(pluginConfig: AgentPluginConfig | null | undefined): ConfirmMap {
  const cfg = pluginConfig?.["pinchy-approvals"];
  if (cfg?.confirm) return cfg.confirm;
  if (!cfg?.confirmTools) return {};
  return Object.fromEntries(cfg.confirmTools.map((id) => [id, "confirm" as const]));
}

/**
 * Does this call need a confirmation?
 *
 * Resolution is most-specific-wins: an explicit `tool:model` cell decides, and
 * an untouched one **inherits the tool setting**. That inheritance is the rule
 * that keeps the control safe. "odoo_delete requires confirmation" covers every
 * model, including ones added next month; a per-model grid only covers cells
 * someone touched. If an untouched cell defaulted to allow, a new model would
 * arrive silently ungated for an admin who believes deletion is gated — the
 * allowlist failure mode AGENTS.md keeps naming, where a positive list cannot
 * report what is not in it.
 *
 * A call spanning several models (`odoo_reconcile` touches `account.move` and
 * `account.payment`) takes the **strictest** result. Without that stated rule
 * the outcome is whichever model the loop happened to see first.
 *
 * A `null` resource is one the call touches but we could not name — a ref the
 * model garbled. It resolves through the same inheritance as an unconfigured
 * cell, which is the honest answer: we know a resource is involved and we do
 * not know which, so the tool-level decision stands.
 */
export function resolveConfirmation(
  pluginConfig: AgentPluginConfig | null | undefined,
  toolName: string,
  resources: CallResource[]
): ConfirmSetting {
  const map = getConfirmMap(pluginConfig);
  const toolLevel = map[toolName] ?? "allow";
  if (resources.length === 0) return toolLevel;
  const cell = (resource: CallResource) =>
    resource === null ? toolLevel : (map[`${toolName}${KEY_SEPARATOR}${resource}`] ?? toolLevel);
  return resources.some((resource) => cell(resource) === "confirm") ? "confirm" : "allow";
}

/**
 * Does this agent's policy mention this tool at all — at tool level or in any
 * of its resource cells?
 *
 * The gate calls this before resolving, so the overwhelmingly common answer
 * ("nobody gated this tool") costs one already-loaded object and no further
 * work. Resolving needs the ref-token key, which is a second DB read, and
 * paying it on every tool call to answer "no" would put a settings query in
 * front of every action every agent takes.
 */
export function toolIsConfigured(
  pluginConfig: AgentPluginConfig | null | undefined,
  toolName: string
): boolean {
  const map = getConfirmMap(pluginConfig);
  if (map[toolName] !== undefined) return true;
  const prefix = `${toolName}${KEY_SEPARATOR}`;
  return Object.keys(map).some((key) => key.startsWith(prefix));
}

const POWERFUL_TOOL_IDS = new Set(
  TOOL_REGISTRY.filter((t) => t.category === "powerful").map((t) => t.id)
);

/**
 * Auto-default when an admin first enables confirmation: every `powerful`
 * (write/side-effecting) tool the agent is allowed to use. Safe/read-only
 * tools are left ungated so prompts stay rare (approval-fatigue mitigation).
 *
 * Tool level only — a per-model default would be a guess about which records
 * matter, and the inheritance rule above already carries the tool setting into
 * every model cell.
 */
export function defaultConfirmMap(allowedTools: string[]): ConfirmMap {
  return Object.fromEntries(
    allowedTools.filter((id) => POWERFUL_TOOL_IDS.has(id)).map((id) => [id, "confirm" as const])
  );
}
