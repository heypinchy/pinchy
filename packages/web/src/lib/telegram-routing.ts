/**
 * Which agent a linked user's direct messages to a Telegram bot reach.
 *
 * Two places need the same answer: the config builder writes the OpenClaw
 * bindings that route the messages there (openclaw-config/build.ts), and the
 * allow store lets a user in only once OpenClaw actually routes them there
 * (telegram-allow-store.ts). Should they ever disagree, the allow store would
 * hold a user back for good, or let them in to the wrong agent.
 */

interface RoutableAgent {
  id: string;
  isPersonal: boolean;
  ownerId: string | null;
  createdAt: Date;
}

/**
 * Each owner's personal agent, keyed by user id. Should an owner have two
 * (nothing in the schema forbids it), the oldest wins — never the row order,
 * which neither caller's query fixes, so both callers pick the same one.
 */
export function personalAgentsByOwner(agents: ReadonlyArray<RoutableAgent>): Map<string, string> {
  const oldest = new Map<string, RoutableAgent>();
  for (const agent of agents) {
    if (!agent.isPersonal || !agent.ownerId) continue;
    const current = oldest.get(agent.ownerId);
    if (!current || isOlder(agent, current)) oldest.set(agent.ownerId, agent);
  }
  return new Map([...oldest].map(([ownerId, agent]) => [ownerId, agent.id]));
}

function isOlder(a: RoutableAgent, b: RoutableAgent): boolean {
  const diff = a.createdAt.getTime() - b.createdAt.getTime();
  return diff !== 0 ? diff < 0 : a.id < b.id;
}

/**
 * A shared agent's bot serves its own agent to everyone. A personal agent's
 * bot (Smithers) hands each linked user their own personal agent, so their
 * Telegram chat is the one they see in the web UI. A user without one gets no
 * route (null): the bot's own agent is its owner's private one, so the config
 * builder writes them no binding and the allow store leaves them off the bot.
 */
export function telegramDirectTarget(
  bot: { id: string; isPersonal: boolean },
  userId: string,
  personalAgents: ReadonlyMap<string, string>
): string | null {
  if (!bot.isPersonal) return bot.id;
  return personalAgents.get(userId) ?? null;
}
