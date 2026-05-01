import { readFileSync, existsSync } from "fs";
import { CONFIG_PATH } from "./paths";
import { writeConfigAtomic, readExistingConfig } from "./write";

/**
 * Remove stale Pinchy plugins from the allow list that have no matching entry.
 * OpenClaw validates config schemas for allowed plugins — if a plugin is in
 * `allow` but has no `entries` config, OpenClaw rejects the config and refuses
 * to start. This can happen when an older config volume is reused with a fresh
 * DB (e.g. after deleting pgdata). Runs before setup is complete (no DB needed).
 */
export function sanitizeOpenClawConfig(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const config = JSON.parse(raw);
  const plugins = config.plugins as Record<string, unknown> | undefined;
  if (!plugins) return false;

  const allow = plugins.allow as string[] | undefined;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  if (!allow) return false;

  const cleaned = allow.filter((p) => !p.startsWith("pinchy-") || p in entries);

  if (cleaned.length === allow.length) return false;

  plugins.allow = cleaned;
  writeConfigAtomic(JSON.stringify(config, null, 2).trimEnd() + "\n");
  return true;
}

/**
 * Update only session.identityLinks in the config file.
 *
 * Unlike regenerateOpenClawConfig(), this reads the existing config and only
 * modifies session.identityLinks. All other fields (agents.defaults, env,
 * plugins, channels, meta, etc.) are preserved byte-for-byte. This avoids
 * unnecessary diffs that trigger hot-reloads breaking Telegram polling
 * (openclaw#47458).
 *
 * OpenClaw treats identityLinks changes as "dynamic reads" — no channel
 * restart, no hot-reload, just updated in memory.
 */
export function updateIdentityLinks(identityLinks: Record<string, string[]>): void {
  const existing = readExistingConfig();

  // Same safety as updateTelegramChannelConfig — see comment there.
  const existingGateway = existing.gateway as Record<string, unknown> | undefined;
  if (!existingGateway?.mode) {
    throw new Error(
      "[openclaw-config] updateIdentityLinks: existing config has no gateway.mode " +
        "(likely EACCES race on /openclaw-config/openclaw.json). Retry the request."
    );
  }

  const session = (existing.session as Record<string, unknown>) || {};
  const updatedSession = {
    ...session,
    identityLinks,
  };

  const updated = { ...existing, session: updatedSession };

  // Only write if content actually changed. Format matches OpenClaw's
  // writeConfigFile output (trimEnd + "\n") so SHA256 hashes line up
  // for the reload-subsystem dedup. See call site of regenerateOpenClawConfig
  // for the full rationale.
  const newContent = JSON.stringify(updated, null, 2).trimEnd() + "\n";
  try {
    const current = readFileSync(CONFIG_PATH, "utf-8");
    if (current === newContent) return;
  } catch {
    // File doesn't exist — write it
  }

  writeConfigAtomic(newContent);
}

/**
 * Update a single Telegram account in the config (add or remove).
 *
 * Uses OpenClaw's multi-account format: channels.telegram.accounts.<accountId>.
 * Preserves all other accounts, bindings, and OpenClaw-enriched fields.
 *
 * Pass `account: null` to remove an account. When the last account is removed,
 * the entire telegram channel config is removed.
 *
 * Used by bot connect/disconnect to avoid full config regeneration, which
 * overwrites OpenClaw-enriched fields (agents.defaults.*) and triggers
 * hot-reloads that break Telegram polling (openclaw#47458).
 */
export function updateTelegramChannelConfig(
  accountId: string | null,
  account: { botToken: string } | null,
  identityLinks: Record<string, string[]> | null
): void {
  const existing = readExistingConfig();

  // Safety: refuse to write a config that would clobber the gateway block.
  // If readExistingConfig returned an empty/partial object (EACCES race or
  // corrupted file), modifying channels/bindings on top of it and writing
  // back would produce a config without gateway.mode — OpenClaw refuses
  // to start with "Gateway start blocked: existing config is missing
  // gateway.mode" and falls into a restart loop. Throwing here lets the
  // calling API route return 503 to the user instead of silently dropping
  // the channel update.
  const existingGateway = existing.gateway as Record<string, unknown> | undefined;
  if (!existingGateway?.mode) {
    throw new Error(
      "[openclaw-config] updateTelegramChannelConfig: existing config has no gateway.mode " +
        "(likely EACCES race on /openclaw-config/openclaw.json). Retry the request."
    );
  }

  if (accountId && account) {
    const existingTelegram =
      ((existing.channels as Record<string, unknown>)?.telegram as Record<string, unknown>) || {};
    const existingAccounts = (existingTelegram.accounts as Record<string, unknown>) || {};

    existingAccounts[accountId] = { botToken: account.botToken };

    existing.channels = {
      ...((existing.channels as Record<string, unknown>) || {}),
      telegram: {
        ...existingTelegram,
        dmPolicy: "pairing",
        accounts: existingAccounts,
      },
    };

    // Update bindings: add this account's binding, preserve others
    const existingBindings =
      (existing.bindings as Array<{ agentId: string; match: Record<string, string> }>) || [];
    const otherBindings = existingBindings.filter((b) => b.match?.accountId !== accountId);
    existing.bindings = [
      ...otherBindings,
      { agentId: accountId, match: { channel: "telegram", accountId } },
    ];
  } else if (accountId && !account) {
    const existingTelegram =
      ((existing.channels as Record<string, unknown>)?.telegram as Record<string, unknown>) || {};
    const existingAccounts = (existingTelegram.accounts as Record<string, unknown>) || {};

    delete existingAccounts[accountId];

    if (Object.keys(existingAccounts).length === 0) {
      // Last account removed — remove entire telegram config
      const channels = (existing.channels as Record<string, unknown>) || {};
      delete channels.telegram;
      existing.channels = Object.keys(channels).length > 0 ? channels : undefined;
      existing.bindings = undefined;
    } else {
      existing.channels = {
        ...((existing.channels as Record<string, unknown>) || {}),
        telegram: { ...existingTelegram, accounts: existingAccounts },
      };
      // Remove this account's binding
      const existingBindings =
        (existing.bindings as Array<{ agentId: string; match: Record<string, string> }>) || [];
      existing.bindings = existingBindings.filter((b) => b.match?.accountId !== accountId);
    }
  } else {
    // No accountId — remove ALL telegram config (used by remove-all)
    const channels = (existing.channels as Record<string, unknown>) || {};
    delete channels.telegram;
    existing.channels = Object.keys(channels).length > 0 ? channels : undefined;
    existing.bindings = undefined;
  }

  const session = (existing.session as Record<string, unknown>) || {};
  existing.session = {
    ...session,
    dmScope: "per-peer",
    // null = "don't touch existing identityLinks" (used by bot connect/disconnect).
    // Non-null = overwrite with provided value (used by link/unlink).
    ...(identityLinks !== null && { identityLinks }),
  };

  const newContent = JSON.stringify(existing, null, 2).trimEnd() + "\n";
  try {
    const current = readFileSync(CONFIG_PATH, "utf-8");
    if (current === newContent) return;
  } catch {
    // File doesn't exist
  }

  writeConfigAtomic(newContent);
}
