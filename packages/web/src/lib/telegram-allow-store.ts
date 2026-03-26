/**
 * Manage OpenClaw's native allow-from store for Telegram.
 *
 * OpenClaw has a dual allowFrom system:
 * 1. Config allowFrom (channels.telegram.allowFrom in JSON) — triggers channel restart on change
 * 2. Store allowFrom (credentials/telegram-allowFrom.json) — no config change, no restart
 *
 * We use the store to avoid triggering OpenClaw's broken channel restart
 * (openclaw/openclaw#47458) which kills Telegram long-polling.
 *
 * The store format matches OpenClaw's internal format (see reply-*.js in OpenClaw dist).
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
const STORE_PATH = join(dirname(CONFIG_PATH), "credentials", "telegram-allowFrom.json");

interface AllowFromStore {
  version: 1;
  allowFrom: string[];
}

function readStore(): AllowFromStore | null {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writeStore(store: AllowFromStore) {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Atomic write: write to temp file then rename
  const tmpPath = STORE_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o644 });
  renameSync(tmpPath, STORE_PATH);
}

export function addToAllowStore(telegramUserId: string) {
  const store = readStore() || { version: 1, allowFrom: [] };
  if (store.allowFrom.includes(telegramUserId)) return;
  store.allowFrom.push(telegramUserId);
  writeStore(store);
}

export function removeFromAllowStore(telegramUserId: string) {
  const store = readStore();
  if (!store) return;
  const filtered = store.allowFrom.filter((id) => id !== telegramUserId);
  if (filtered.length === store.allowFrom.length) return; // not found
  writeStore({ ...store, allowFrom: filtered });
}

export function clearAllowStore() {
  const store = readStore();
  if (!store) return;
  writeStore({ ...store, allowFrom: [] });
}

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
