// Read and write OpenClaw's channel pairing store on Pinchy's behalf.
//
// Pinchy decides who may write to a Telegram bot: a user links their Telegram
// account by sending the bot's pairing code to Pinchy, and Pinchy computes each
// bot's allow list from its permissions (see telegram-allow-store.ts in
// packages/web). Up to OpenClaw 2026.8 both lived in JSON files under
// `credentials/` on the shared volume, and Pinchy read and wrote them directly.
// OpenClaw 2026.9 moved them into its global state database,
// `state/openclaw.sqlite`, which only the gateway process can open safely. So
// the reads and writes happen here, and Pinchy asks for them over the gateway
// connection it already holds.
//
// OpenClaw's native `channels.pairing.approve` is no substitute: it approves a
// sender for one account, while Pinchy grants access across all of a user's
// bots and takes it away again when a permission changes.
//
// OpenClaw reads both tables fresh on every message and rewrites a channel's
// rows inside an IMMEDIATE transaction with a busy timeout, so a second
// connection that does the same is safe.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PAIRING_FIND_BY_CODE_METHOD = "pinchy.pairing.findByCode";
export const PAIRING_REMOVE_REQUESTS_METHOD = "pinchy.pairing.removeRequests";
export const PAIRING_SET_ALLOW_FROM_METHOD = "pinchy.pairing.setAllowFrom";

const BUSY_TIMEOUT_MS = 5000;

export interface PairingRequest {
  /** The sender's id on the channel: the Telegram user id. */
  id: string;
  code: string;
  /** The account (bot) the sender asked to pair with. */
  accountId: string;
  createdAt: string;
  lastSeenAt: string;
}

class InvalidRequestError extends Error {}

function databasePath(stateDir: string): string {
  return join(stateDir, "state", "openclaw.sqlite");
}

// The keys exactly as OpenClaw stores them (`safeChannelKey` and
// `resolveAllowFromAccountId` in its pairing store). A key written any other
// way is a row OpenClaw never reads.
function channelKey(channel: string): string {
  const safe = channel
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\.\./g, "_");
  if (!safe || safe === "_") throw new InvalidRequestError("Invalid channel");
  return safe;
}

function accountKey(accountId: string): string {
  return accountId.trim().toLowerCase() || "default";
}

function open(stateDir: string, readOnly: boolean): DatabaseSync | null {
  const path = databasePath(stateDir);
  // OpenClaw creates the database with its schema on first start. Opening it
  // here first would leave an empty file it then finds without one.
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function inWriteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function findPairingRequestByCode(params: {
  stateDir: string;
  channel: string;
  code: string;
}): PairingRequest | null {
  const key = channelKey(params.channel);
  const db = open(params.stateDir, true);
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `select request_id, account_id, code, created_at, last_seen_at
           from channel_pairing_requests
          where channel_key = ? and upper(code) = upper(?)
          order by created_at desc
          limit 1`
      )
      .get(key, params.code.trim()) as
      | {
          request_id: string;
          account_id: string;
          code: string;
          created_at: string;
          last_seen_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.request_id,
      code: row.code,
      accountId: row.account_id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  } finally {
    db.close();
  }
}

/**
 * Remove a sender's pending requests on every account of the channel: once a
 * user is linked, the code they used, and any they asked other bots for, is
 * spent. Answers how many rows went.
 */
export function removePairingRequests(params: {
  stateDir: string;
  channel: string;
  requestId: string;
}): number {
  const key = channelKey(params.channel);
  const db = open(params.stateDir, false);
  if (!db) return 0;
  try {
    return inWriteTransaction(db, () =>
      Number(
        db
          .prepare("delete from channel_pairing_requests where channel_key = ? and request_id = ?")
          .run(key, params.requestId).changes
      )
    );
  } finally {
    db.close();
  }
}

/**
 * Write the channel's allow lists. With `replaceAll`, every account the map
 * leaves out loses its list, which is how a deleted bot's grants go; without
 * it, only the named accounts change.
 */
export function setPairingAllowFrom(params: {
  stateDir: string;
  channel: string;
  allowFrom: Record<string, string[]>;
  replaceAll: boolean;
}): number {
  const key = channelKey(params.channel);
  const db = open(params.stateDir, false);
  // Unlike a read, a write that finds no database must not look like success:
  // the grants it carries would be silently lost.
  if (!db) throw new Error("OpenClaw has not created its state database yet");
  try {
    return inWriteTransaction(db, () => {
      const deleteAccount = db.prepare(
        "delete from channel_pairing_allow_entries where channel_key = ? and account_id = ?"
      );
      const insert = db.prepare(
        `insert into channel_pairing_allow_entries
           (channel_key, account_id, entry, sort_order, updated_at)
         values (?, ?, ?, ?, ?)`
      );
      if (params.replaceAll) {
        db.prepare("delete from channel_pairing_allow_entries where channel_key = ?").run(key);
      }
      const updatedAt = Date.now();
      const accounts = Object.entries(params.allowFrom);
      for (const [accountId, entries] of accounts) {
        const account = accountKey(accountId);
        if (!params.replaceAll) deleteAccount.run(key, account);
        const seen = new Set<string>();
        for (const raw of entries) {
          const entry = raw.trim();
          if (!entry || entry === "*" || seen.has(entry)) continue;
          seen.add(entry);
          insert.run(key, account, entry, seen.size - 1, updatedAt);
        }
      }
      return accounts.length;
    });
  } finally {
    db.close();
  }
}

type Respond = (
  ok: boolean,
  payload?: unknown,
  error?: { code: "INVALID_REQUEST" | "UNAVAILABLE"; message: string }
) => void;

type Handler = (opts: { params: Record<string, unknown>; respond: Respond }) => void;

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRequestError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireAllowFrom(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequestError("allowFrom must be a map of account id to sender ids");
  }
  for (const entries of Object.values(value)) {
    if (!Array.isArray(entries) || !entries.every((e) => typeof e === "string")) {
      throw new InvalidRequestError("allowFrom must be a map of account id to sender ids");
    }
  }
  return value as Record<string, string[]>;
}

function handler(run: (params: Record<string, unknown>) => unknown): Handler {
  return ({ params, respond }) => {
    try {
      respond(true, run(params));
    } catch (err) {
      respond(false, undefined, {
        code: err instanceof InvalidRequestError ? "INVALID_REQUEST" : "UNAVAILABLE",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/** `pinchy.pairing.findByCode` — params `channel`, `code`; answers `{ request }`. */
export function createPairingFindByCodeMethod(resolveStateDir: () => string): Handler {
  return handler((params) => {
    const channel = requireString(params, "channel");
    const code = requireString(params, "code");
    return { request: findPairingRequestByCode({ stateDir: resolveStateDir(), channel, code }) };
  });
}

/** `pinchy.pairing.removeRequests` — params `channel`, `requestId`; answers `{ removed }`. */
export function createPairingRemoveRequestsMethod(resolveStateDir: () => string): Handler {
  return handler((params) => {
    const channel = requireString(params, "channel");
    const requestId = requireString(params, "requestId");
    return {
      removed: removePairingRequests({ stateDir: resolveStateDir(), channel, requestId }),
    };
  });
}

/**
 * Where OpenClaw sends a direct message from `peerId` to bot `accountId` under
 * the config it is running with right now: the agent id its routing picks.
 * Throws when no binding routes the message, as OpenClaw does.
 */
export type ResolveRoute = (params: {
  channel: string;
  accountId: string;
  peerId: string;
}) => string;

export interface WithheldSender {
  accountId: string;
  peerId: string;
}

function requireRouteTo(value: unknown): Record<string, Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const invalid = () =>
    new InvalidRequestError("routeTo must be a map of account id to sender id to agent id");
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  for (const senders of Object.values(value)) {
    if (typeof senders !== "object" || senders === null || Array.isArray(senders)) throw invalid();
    if (!Object.values(senders).every((agentId) => typeof agentId === "string")) throw invalid();
  }
  return value as Record<string, Record<string, string>>;
}

// OpenClaw lowercases agent ids (`normalizeAgentId`); Pinchy's are UUIDs.
function sameAgent(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Hold back every sender OpenClaw would not yet route to the agent Pinchy
 * meant. Pinchy pushes the bindings that route a linked user to their own
 * agent in the background, and OpenClaw may take up to a minute to load them
 * (config.apply is rate-limited). Until it does, a bot's account-wide binding
 * sends that user's messages to the bot owner's agent. Letting them in before
 * then would hand them someone else's agent, so they wait, and Pinchy asks
 * again until they are through.
 */
function withholdMisrouted(
  channel: string,
  allowFrom: Record<string, string[]>,
  routeTo: Record<string, Record<string, string>>,
  resolveRoute: ResolveRoute
): { allowFrom: Record<string, string[]>; withheld: WithheldSender[] } {
  const withheld: WithheldSender[] = [];
  const kept: Record<string, string[]> = {};
  for (const [accountId, entries] of Object.entries(allowFrom)) {
    kept[accountId] = entries.filter((raw) => {
      const peerId = raw.trim();
      const expected = routeTo[accountId]?.[peerId];
      if (expected === undefined) return true;
      let routed: string | null;
      try {
        routed = resolveRoute({ channel, accountId, peerId });
      } catch {
        routed = null;
      }
      if (routed !== null && sameAgent(routed, expected)) return true;
      withheld.push({ accountId, peerId });
      return false;
    });
  }
  return { allowFrom: kept, withheld };
}

/**
 * `pinchy.pairing.setAllowFrom` — params `channel`, `allowFrom` (account id →
 * sender ids), `replaceAll` and optionally `routeTo` (account id → sender id →
 * the agent that sender must reach). A sender with an entry in `routeTo` is
 * only written once OpenClaw routes them there (see withholdMisrouted).
 * Answers `{ accounts, withheld }`.
 */
export function createPairingSetAllowFromMethod(
  resolveStateDir: () => string,
  resolveRoute: ResolveRoute
): Handler {
  return handler((params) => {
    const channel = requireString(params, "channel");
    const requested = requireAllowFrom(params.allowFrom);
    const routeTo = requireRouteTo(params.routeTo);
    if (typeof params.replaceAll !== "boolean") {
      throw new InvalidRequestError("replaceAll must be a boolean");
    }
    const { allowFrom, withheld } = routeTo
      ? withholdMisrouted(channel, requested, routeTo, resolveRoute)
      : { allowFrom: requested, withheld: [] };
    return {
      accounts: setPairingAllowFrom({
        stateDir: resolveStateDir(),
        channel,
        allowFrom,
        replaceAll: params.replaceAll,
      }),
      withheld,
    };
  });
}
