/**
 * Manage OpenClaw's native allow-from store for Telegram.
 *
 * OpenClaw has a dual allowFrom system:
 * 1. Config allowFrom (channels.telegram.allowFrom in JSON) — triggers channel restart on change
 * 2. Store allowFrom (OpenClaw's pairing store) — no config change, no restart
 *
 * We use the store to avoid triggering OpenClaw's broken channel restart
 * (openclaw/openclaw#47458) which kills Telegram long-polling.
 *
 * Multi-account: each agent with a Telegram bot is one account in the store.
 * The central recalculateTelegramAllowStores() function computes the correct
 * state from DB (agents, groups, channelLinks) and writes it in one call.
 *
 * Since OpenClaw 2026.9 the store is a table in OpenClaw's state database, not
 * a JSON file per account, and the pinchy-audit plugin writes it for us (see
 * openclaw-pairing-store.ts). While the gateway is disconnected the writes are
 * skipped: server.ts recalculates whenever the connection comes back, which
 * also carries the lists over from the files an older OpenClaw used.
 */

import { db } from "@/db";
import { agents, channelLinks, agentGroups, userGroups, users } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";
import { getSettingsByKeys, getSettingsByPrefix } from "@/lib/settings";
import { getInstancePolicy, isPausedPersonalAgent } from "@/lib/instance-policy";
import { personalAgentsByOwner, telegramDirectTarget } from "@/lib/telegram-routing";
import {
  callPairingStore,
  OpenClawNotConnectedError,
  PAIRING_REMOVE_REQUESTS_METHOD,
  PAIRING_SET_ALLOW_FROM_METHOD,
} from "@/lib/openclaw-pairing-store";

/**
 * Write allow lists. `replaceAll` drops every account the map leaves out;
 * without it, only the named accounts change. `routeTo` names, per account and
 * sender, the agent the sender must reach: pinchy-audit holds back a sender
 * OpenClaw does not route there yet and answers with them as `withheld`.
 * Skipped, with a log line, while OpenClaw is disconnected; any other failure
 * throws, because a revocation that silently did not land would leave a user
 * with access they lost. Answers how many senders were held back.
 */
async function writeAllowFrom(
  allowFrom: Record<string, string[]>,
  replaceAll: boolean,
  routeTo?: Record<string, Record<string, string>>
): Promise<number> {
  let response: unknown;
  try {
    response = await callPairingStore(PAIRING_SET_ALLOW_FROM_METHOD, {
      allowFrom,
      replaceAll,
      ...(routeTo ? { routeTo } : {}),
    });
  } catch (err) {
    if (err instanceof OpenClawNotConnectedError) {
      console.warn(
        "[telegram-allow-store]",
        "OpenClaw is not connected; the allow lists are rewritten when it reconnects"
      );
      return 0;
    }
    throw err;
  }
  const withheld = (response as { withheld?: unknown } | null)?.withheld;
  return Array.isArray(withheld) ? withheld.length : 0;
}

// ── Per-account store functions ─────────────────────────────────────

export async function clearAllowStoreForAccount(accountId: string): Promise<void> {
  await writeAllowFrom({ [accountId]: [] }, false);
}

export async function clearAllAllowStores(): Promise<void> {
  await writeAllowFrom({}, true);
}

// ── Central recalculate function ────────────────────────────────────

/**
 * Recompute ALL per-account Telegram allow-from stores from DB state.
 *
 * This is the single source of truth for Telegram access control.
 * Called after any event that changes permissions: user link/unlink,
 * group membership changes, agent visibility changes, etc.
 *
 * Idempotent: always produces the correct state regardless of prior state.
 * Serialized via in-process mutex so an older computation never lands after a
 * newer one.
 */
let recalculateMutex: Promise<void> = Promise.resolve();

export function recalculateTelegramAllowStores(): Promise<void> {
  return enqueueRecalculation(false);
}

// While pinchy-audit holds a sender back, the run is repeated: soon at first,
// since OpenClaw usually loads the new bindings within seconds, at least every
// 15 s while a push may sit behind config.apply's rate limit (33–53 s), then
// rarely, so a binding that never arrives costs one call every five minutes.
// Any run replaces the pending retry, and one that lets everyone through ends it.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 15_000, 15_000, 15_000, 30_000, 60_000, 300_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function enqueueRecalculation(isRetry: boolean): Promise<void> {
  // Serialize concurrent calls — each waits for the previous to complete
  recalculateMutex = recalculateMutex
    .catch(() => {}) // don't let a failed previous run block the next
    .then(async () => {
      let withheld: number;
      try {
        withheld = await recalculateTelegramAllowStoresImpl();
      } catch (err) {
        // A failed retry must not end the retries; a failed regular run keeps
        // whichever retry is pending.
        if (isRetry) scheduleRetry(true);
        throw err;
      }
      if (withheld > 0) {
        scheduleRetry(isRetry);
      } else {
        cancelRetry();
      }
    });
  return recalculateMutex;
}

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryAttempt = 0;
}

function scheduleRetry(isRetry: boolean): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryAttempt = isRetry ? retryAttempt + 1 : 0;
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  console.info(
    "[telegram-allow-store]",
    `OpenClaw does not route every linked Telegram user to their agent yet; asking again in ${delay / 1000} s`
  );
  retryTimer = setTimeout(() => {
    retryTimer = null;
    enqueueRecalculation(true).catch((err) =>
      console.error("[telegram-allow-store] retrying the allow lists failed:", err)
    );
  }, delay);
  retryTimer.unref?.();
}

/** Answers how many senders pinchy-audit held back (see writeAllowFrom). */
async function recalculateTelegramAllowStoresImpl(): Promise<number> {
  // 1. Get all non-deleted agents (including personal ones like Smithers,
  // which can have Telegram bots connected via Settings → Telegram)
  const allAgents = await db.select().from(agents).where(isNull(agents.deletedAt));

  // 2. Find which agents have bot tokens. Batched: one `telegram_bot_token:`
  // prefix query instead of a `getSetting` round-trip per agent (#261 N+1).
  const botTokenByKey = await getSettingsByPrefix("telegram_bot_token:");
  const agentsWithBots: Array<{ id: string; visibility: string; isPersonal: boolean }> = [];
  for (const agent of allAgents) {
    const botToken = botTokenByKey.get(`telegram_bot_token:${agent.id}`);
    if (botToken) {
      agentsWithBots.push({
        id: agent.id,
        visibility: agent.visibility,
        isPersonal: agent.isPersonal,
      });
    }
  }

  // 3. The whole channel is written at once and replaces what was there, so
  // an account without a bot (deleted agent, disconnected bot) loses its list.
  const allowFrom: Record<string, string[]> = {};
  for (const agent of agentsWithBots) allowFrom[agent.id] = [];
  if (agentsWithBots.length === 0) {
    return writeAllowFrom(allowFrom, true);
  }

  // 4. Get all Telegram-linked users
  const links = await db.select().from(channelLinks).where(eq(channelLinks.channel, "telegram"));

  if (links.length === 0) {
    // No linked users — every bot gets an empty list
    return writeAllowFrom(allowFrom, true);
  }

  // 5. Get all users (for role check and ban status)
  const allUsers = await db.select().from(users);
  const userMap = new Map(allUsers.map((u) => [u.id, u]));

  // 6. Get all agent-group and user-group relationships
  const allAgentGroups = await db.select().from(agentGroups);
  const allUserGroups = await db.select().from(userGroups);

  // Build lookup maps
  const agentGroupMap = new Map<string, Set<string>>(); // agentId → Set<groupId>
  for (const ag of allAgentGroups) {
    if (!agentGroupMap.has(ag.agentId)) agentGroupMap.set(ag.agentId, new Set());
    agentGroupMap.get(ag.agentId)!.add(ag.groupId);
  }

  const userGroupMap = new Map<string, Set<string>>(); // userId → Set<groupId>
  for (const ug of allUserGroups) {
    if (!userGroupMap.has(ug.userId)) userGroupMap.set(ug.userId, new Set());
    userGroupMap.get(ug.userId)!.add(ug.groupId);
  }

  // Members may be barred from personal agents (Settings → Organization →
  // Member access). Read once, and only when a personal-agent bot exists — it
  // narrows that branch below and nothing else.
  const policy = agentsWithBots.some((a) => a.isPersonal) ? await getInstancePolicy() : null;

  // 7. For each agent with a bot, compute allowed Telegram user IDs
  for (const agent of agentsWithBots) {
    const allowedTelegramIds = allowFrom[agent.id];

    for (const link of links) {
      const user = userMap.get(link.userId);
      if (!user || user.banned) continue;

      if (agent.isPersonal) {
        // Personal agents (e.g. Smithers): all linked users get access.
        // Smithers is personal but the Telegram bot serves everyone — each
        // user's DMs are routed to their OWN personal agent (build.ts). A
        // member whose personal agent is paused is left out entirely: the
        // routing would otherwise fall back to the bot owner's agent.
        if (policy && isPausedPersonalAgent(agent, user.role, policy)) continue;
        allowedTelegramIds.push(link.channelUserId);
      } else if (agent.visibility === "all") {
        // All non-banned linked users get access
        allowedTelegramIds.push(link.channelUserId);
      } else {
        // Restricted: admins always get access, others need group membership
        if (user.role === "admin") {
          allowedTelegramIds.push(link.channelUserId);
        } else {
          const agentGroups = agentGroupMap.get(agent.id);
          const userGroupSet = userGroupMap.get(link.userId);
          if (agentGroups && userGroupSet) {
            // User has access if they share at least one group with the agent
            const hasAccess = [...agentGroups].some((gid) => userGroupSet.has(gid));
            if (hasAccess) {
              allowedTelegramIds.push(link.channelUserId);
            }
          }
        }
      }
    }
  }

  return writeAllowFrom(allowFrom, true, await personalBotRoutes(allAgents, agentsWithBots, links));
}

/**
 * The agent each sender of a personal-agent bot must reach before pinchy-audit
 * lets them in (see writeAllowFrom). The bindings that send a linked user to
 * their own agent reach OpenClaw in the background, up to a minute after the
 * link; until then the bot's account-wide binding would hand them the bot
 * owner's agent. A shared agent's bot has no such gap: its one binding arrives
 * with the bot itself. Neither has a bot OpenClaw is not running after a
 * polling conflict (build.ts leaves it out of the config), so it gets no route
 * to wait for.
 */
async function personalBotRoutes(
  allAgents: ReadonlyArray<{
    id: string;
    isPersonal: boolean;
    ownerId: string | null;
    createdAt: Date;
  }>,
  agentsWithBots: ReadonlyArray<{ id: string; isPersonal: boolean }>,
  links: ReadonlyArray<{ userId: string; channelUserId: string }>
): Promise<Record<string, Record<string, string>>> {
  const personalBots = agentsWithBots.filter((a) => a.isPersonal);
  if (personalBots.length === 0) return {};
  const conflictDisabled = await getSettingsByKeys(
    personalBots.map((bot) => `telegram_conflict_disabled:${bot.id}`)
  );
  const personalAgents = personalAgentsByOwner(allAgents);
  const routeTo: Record<string, Record<string, string>> = {};
  for (const bot of personalBots) {
    if (conflictDisabled.has(`telegram_conflict_disabled:${bot.id}`)) continue;
    routeTo[bot.id] = Object.fromEntries(
      links.map((link) => [
        link.channelUserId,
        telegramDirectTarget(bot, link.userId, personalAgents),
      ])
    );
  }
  return routeTo;
}

// ── Pairing store ───────────────────────────────────────────────────

/**
 * Remove a Telegram user's pending pairing requests from OpenClaw's store.
 *
 * Called when a user links (the code is spent) and when they unlink: OpenClaw
 * keeps handing back an existing pending request instead of sending a new
 * pairing message, so a stale one would leave the user without a fresh code.
 * Cleanup only — a failure is logged and never fails the link or unlink.
 */
export async function removePairingRequest(telegramUserId: string): Promise<void> {
  try {
    await callPairingStore(PAIRING_REMOVE_REQUESTS_METHOD, { requestId: telegramUserId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[telegram-allow-store]", "failed to remove pairing request:", message);
  }
}
