import { getSettingsByPrefix, setSetting } from "@/lib/settings";

/**
 * Instance-wide limits on what **members** may do with a personal agent — the
 * two switches under Settings → Organization → Member access. Design of
 * record: plans/2026-10-16-cost-governance-design.md.
 *
 * They exist for an instance sold at a flat price with the model included,
 * where a member chatting freely with Smithers, or hanging an automation off it
 * that answers every incoming email, turns a known cost into an open one.
 *
 * Three properties every caller relies on:
 *
 * - **Absent means on.** A key nobody wrote reads as the switch being on, so an
 *   upgrade changes nothing until an admin decides otherwise.
 * - **Off pauses, it never deletes.** Nothing here touches an agent, a chat or
 *   an automation; the gates below just stop letting a member through. Turning
 *   a switch back on restores everything as it was.
 * - **Admins are not members.** Both switches apply to the `member` role only;
 *   an owner with no known role counts as a member, never as an admin.
 */
export interface InstancePolicy {
  /** Members can use their personal agent (Smithers). */
  memberPersonalAgents: boolean;
  /** Members can create and run automations on their personal agent. */
  memberAutomations: boolean;
}

const POLICY_PREFIX = "policy.";

export const POLICY_KEYS = {
  memberPersonalAgents: `${POLICY_PREFIX}member_personal_agents`,
  memberAutomations: `${POLICY_PREFIX}member_automations`,
} as const satisfies Record<keyof InstancePolicy, string>;

/**
 * An absent key is on; a written key is on only when it says exactly "true".
 * The only writer is `setInstancePolicy`, so anything else is a value nobody
 * meant — and a restriction must not fail open on it.
 */
function readSwitch(value: string | undefined): boolean {
  return value === undefined ? true : value === "true";
}

export async function getInstancePolicy(): Promise<InstancePolicy> {
  const stored = await getSettingsByPrefix(POLICY_PREFIX);
  return {
    memberPersonalAgents: readSwitch(stored.get(POLICY_KEYS.memberPersonalAgents)),
    memberAutomations: readSwitch(stored.get(POLICY_KEYS.memberAutomations)),
  };
}

export async function setInstancePolicy(policy: InstancePolicy): Promise<void> {
  await setSetting(POLICY_KEYS.memberPersonalAgents, String(policy.memberPersonalAgents));
  await setSetting(POLICY_KEYS.memberAutomations, String(policy.memberAutomations));
}

/**
 * Whether a settings key belongs to this module. The generic
 * `POST /api/settings` refuses these: written there, a switch would skip the
 * from/to audit diff and the OpenClaw/Telegram refresh its own route performs.
 */
export function isPolicyKey(key: string): boolean {
  return key.startsWith(POLICY_PREFIX);
}

function isMemberPersonalAgent(
  agent: { isPersonal: boolean },
  ownerRole: string | null | undefined
): boolean {
  return agent.isPersonal && ownerRole !== "admin";
}

/**
 * True when this agent is a member's personal agent and members may not use
 * one. `ownerRole` is the role of the agent's OWNER — on the access paths that
 * is the caller, since only the owner ever gets this far.
 */
export function isPausedPersonalAgent(
  agent: { isPersonal: boolean },
  ownerRole: string | null | undefined,
  policy: InstancePolicy
): boolean {
  return isMemberPersonalAgent(agent, ownerRole) && !policy.memberPersonalAgents;
}

/**
 * True when automations on this agent must not run or be switched on. Pausing
 * the personal agent pauses its automations as well: an automation runs AS its
 * agent, so it cannot outlive the agent being off.
 */
export function arePersonalAutomationsPaused(
  agent: { isPersonal: boolean },
  ownerRole: string | null | undefined,
  policy: InstancePolicy
): boolean {
  return (
    isMemberPersonalAgent(agent, ownerRole) &&
    (!policy.memberPersonalAgents || !policy.memberAutomations)
  );
}
