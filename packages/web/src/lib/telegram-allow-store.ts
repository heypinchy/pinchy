/**
 * Manage OpenClaw's native allow-from store for Telegram.
 *
 * OpenClaw has a dual allowFrom system:
 * 1. Config allowFrom (channels.telegram.allowFrom in JSON) — triggers channel restart on change
 * 2. Store allowFrom (credentials/telegram-<accountId>-allowFrom.json) — no config change, no restart
 *
 * We use the store to avoid triggering OpenClaw's broken channel restart
 * (openclaw/openclaw#47458) which kills Telegram long-polling.
 *
 * Multi-account: Each agent with a Telegram bot gets its own store file.
 * The central recalculateTelegramAllowStores() function computes the correct
 * state from DB (agents, groups, channelLinks) and writes all store files.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "fs";
import { dirname, join } from "path";
import { db } from "@/db";
import { agents, channelLinks, agentGroups, userGroups, users } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { getSetting } from "@/lib/settings";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
const CREDENTIALS_DIR = join(dirname(CONFIG_PATH), "credentials");

// Legacy single-store path (pre-multi-account)
const LEGACY_STORE_PATH = join(CREDENTIALS_DIR, "telegram-allowFrom.json");

interface AllowFromStore {
  version: 1;
  allowFrom: string[];
}

// ── Per-account store paths ─────────────────────────────────────────

export function getStorePathForAccount(accountId: string): string {
  return join(CREDENTIALS_DIR, `telegram-${accountId}-allowFrom.json`);
}

// ── Low-level store I/O ─────────────────────────────────────────────

function readStoreAt(path: string): AllowFromStore | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeStoreAt(path: string, store: AllowFromStore) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Atomic write: write to temp file then rename
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o644 });
  renameSync(tmpPath, path);
}

// ── Legacy single-store functions (used by existing routes) ─────────

export function addToAllowStore(telegramUserId: string) {
  const store = readStoreAt(LEGACY_STORE_PATH) || { version: 1 as const, allowFrom: [] };
  if (store.allowFrom.includes(telegramUserId)) return;
  store.allowFrom.push(telegramUserId);
  writeStoreAt(LEGACY_STORE_PATH, store);
}

export function removeFromAllowStore(telegramUserId: string) {
  const store = readStoreAt(LEGACY_STORE_PATH);
  if (!store) return;
  const filtered = store.allowFrom.filter((id) => id !== telegramUserId);
  if (filtered.length === store.allowFrom.length) return; // not found
  writeStoreAt(LEGACY_STORE_PATH, { ...store, allowFrom: filtered });
}

export function clearAllowStore() {
  const store = readStoreAt(LEGACY_STORE_PATH);
  if (!store) return;
  writeStoreAt(LEGACY_STORE_PATH, { ...store, allowFrom: [] });
}

// ── Per-account store functions ─────────────────────────────────────

export function clearAllowStoreForAccount(accountId: string) {
  const path = getStorePathForAccount(accountId);
  const store = readStoreAt(path);
  if (!store) return;
  writeStoreAt(path, { ...store, allowFrom: [] });
}

export function clearAllAllowStores() {
  if (!existsSync(CREDENTIALS_DIR)) return;
  const files = readdirSync(CREDENTIALS_DIR);
  for (const file of files) {
    if (file.match(/^telegram-.*allowFrom\.json$/)) {
      const path = join(CREDENTIALS_DIR, file);
      const store = readStoreAt(path);
      if (store) {
        writeStoreAt(path, { ...store, allowFrom: [] });
      }
    }
  }
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
 * Serialized via in-process mutex to prevent concurrent writes from producing
 * inconsistent store files.
 */
let recalculateMutex: Promise<void> = Promise.resolve();

export function recalculateTelegramAllowStores(): Promise<void> {
  // Serialize concurrent calls — each waits for the previous to complete
  recalculateMutex = recalculateMutex
    .catch(() => {}) // don't let a failed previous run block the next
    .then(() => recalculateTelegramAllowStoresImpl());
  return recalculateMutex;
}

async function recalculateTelegramAllowStoresImpl(): Promise<void> {
  // 1. Get all non-deleted agents (including personal ones like Smithers,
  // which can have Telegram bots connected via Settings → Telegram)
  const allAgents = await db.select().from(agents).where(isNull(agents.deletedAt));

  // 2. Find which agents have bot tokens
  const agentsWithBots: Array<{ id: string; visibility: string; isPersonal: boolean }> = [];
  for (const agent of allAgents) {
    const botToken = await getSetting(`telegram_bot_token:${agent.id}`);
    if (botToken) {
      agentsWithBots.push({
        id: agent.id,
        visibility: agent.visibility,
        isPersonal: agent.isPersonal,
      });
    }
  }

  // 3. If no bots, just clean up orphaned files and return
  if (agentsWithBots.length === 0) {
    cleanupOrphanedStoreFiles([]);
    return;
  }

  // 4. Get all Telegram-linked users
  const links = await db.select().from(channelLinks).where(eq(channelLinks.channel, "telegram"));

  if (links.length === 0) {
    // No linked users — write empty stores for all agents with bots
    for (const agent of agentsWithBots) {
      writeStoreAt(getStorePathForAccount(agent.id), { version: 1, allowFrom: [] });
    }
    cleanupOrphanedStoreFiles(agentsWithBots.map((a) => a.id));
    return;
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

  // 7. For each agent with a bot, compute allowed Telegram user IDs
  for (const agent of agentsWithBots) {
    const allowedTelegramIds: string[] = [];

    for (const link of links) {
      const user = userMap.get(link.userId);
      if (!user || user.banned) continue;

      if (agent.isPersonal) {
        // Personal agents (e.g. Smithers): all linked users get access.
        // Smithers is personal but the Telegram bot serves everyone.
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

    writeStoreAt(getStorePathForAccount(agent.id), {
      version: 1,
      allowFrom: allowedTelegramIds,
    });
  }

  // 8. Clean up orphaned store files and legacy file
  cleanupOrphanedStoreFiles(agentsWithBots.map((a) => a.id));
}

/**
 * Remove store files for accounts that no longer have bots,
 * and the legacy single-store file.
 */
function cleanupOrphanedStoreFiles(activeAccountIds: string[]) {
  if (!existsSync(CREDENTIALS_DIR)) return;

  const activeFiles = new Set(activeAccountIds.map((id) => `telegram-${id}-allowFrom.json`));
  const files = readdirSync(CREDENTIALS_DIR);

  for (const file of files) {
    // Match per-account files and legacy file
    if (file.match(/^telegram-.*allowFrom\.json$/) && !activeFiles.has(file)) {
      try {
        unlinkSync(join(CREDENTIALS_DIR, file));
      } catch {
        // File may have been removed concurrently
      }
    }
  }
}

// ── Pairing store ───────────────────────────────────────────────────

/**
 * Remove a pairing request from OpenClaw's pairing store.
 *
 * When a user unlinks their Telegram account, the old pairing code must be
 * removed. Otherwise, upsertPairingRequest() in OpenClaw returns created:false
 * for the existing code and no new pairing message is sent.
 */
const PAIRING_PATH = join(dirname(CONFIG_PATH), "credentials", "telegram-pairing.json");

interface PairingStore {
  version: number;
  requests: Array<{ id: string; code: string; [key: string]: unknown }>;
}

function readPairingStore(): PairingStore | null {
  try {
    return JSON.parse(readFileSync(PAIRING_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function removePairingRequest(telegramUserId: string) {
  const store = readPairingStore();
  if (!store?.requests) return;
  const filtered = store.requests.filter((r) => r.id !== telegramUserId);
  if (filtered.length === store.requests.length) return; // not found
  const tmpPath = PAIRING_PATH + ".tmp";
  const dir = dirname(PAIRING_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(tmpPath, JSON.stringify({ ...store, requests: filtered }, null, 2), {
    encoding: "utf-8",
    mode: 0o644,
  });
  renameSync(tmpPath, PAIRING_PATH);
}
