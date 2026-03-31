import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getDefaultModel } from "@/lib/provider-models";
import { db } from "@/db";
import { agents, channelLinks } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { computeDeniedGroups } from "@/lib/tool-registry";
import { getOpenClawWorkspacePath } from "@/lib/workspace";
import { restartState } from "@/server/restart-state";
import { migrateExistingSmithers } from "@/lib/migrate-onboarding";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

/** Atomic write: tmp file + rename to prevent OpenClaw reading a truncated config */
function writeConfigAtomic(content: string) {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = CONFIG_PATH + ".tmp";
  writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o644 });
  renameSync(tmpPath, CONFIG_PATH);
}

interface OpenClawConfigParams {
  provider: ProviderName;
  apiKey: string;
  model: string;
}

function readExistingConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function writeOpenClawConfig({ provider, apiKey, model }: OpenClawConfigParams) {
  const existing = readExistingConfig();

  // Generate auth token if none exists in the existing config
  const existingGateway = (existing.gateway as Record<string, unknown>) || {};
  const existingAuth = (existingGateway.auth as Record<string, unknown>) || {};
  const token = (existingAuth.token as string) || randomBytes(24).toString("hex");

  const pinchyFields = {
    gateway: {
      mode: "local",
      bind: "lan",
      auth: { mode: "token", token },
    },
    env: {
      [PROVIDERS[provider].envVar]: apiKey,
    },
    agents: {
      defaults: {
        model: { primary: model },
      },
    },
  };

  const merged = deepMerge(existing, pinchyFields);
  writeConfigAtomic(JSON.stringify(merged, null, 2));
  restartState.notifyRestart();
}

export async function regenerateOpenClawConfig() {
  // Migrate existing Smithers agents first, so their updated allowedTools
  // are reflected in the config we're about to generate.
  await migrateExistingSmithers();

  const existing = readExistingConfig();

  // Preserve only the gateway block from existing config (contains auth token,
  // mode, bind, and any OpenClaw-generated fields). Everything else is rebuilt
  // from DB state so deleted providers/agents get cleaned up.
  const gateway = (existing.gateway as Record<string, unknown>) || { mode: "local", bind: "lan" };
  // Ensure mode and bind are always set
  gateway.mode = "local";
  gateway.bind = "lan";

  // Read all agents from DB
  const allAgents = await db.select().from(agents);

  // Read provider API keys from settings
  const env: Record<string, string> = {};
  for (const [, providerConfig] of Object.entries(PROVIDERS)) {
    const apiKey = await getSetting(providerConfig.settingsKey);
    if (apiKey) {
      env[providerConfig.envVar] = apiKey;
    }
  }

  // Only set defaults.model — nothing else. OpenClaw enriches agents.defaults
  // with heartbeat, models, contextPruning, compaction at runtime. If Pinchy
  // writes those fields (even to preserve them), it causes a race condition:
  // after a full restart, OpenClaw hasn't enriched yet → Pinchy writes without
  // them → OpenClaw enriches → diff detected → hot-reload → polling dies
  // (openclaw#47458). By only writing model, we avoid touching any other field.
  const pinchyDefaults: Record<string, unknown> = {};
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  if (defaultProvider && PROVIDERS[defaultProvider]) {
    pinchyDefaults.model = { primary: await getDefaultModel(defaultProvider) };
  }

  // Build agents list with OpenClaw-side workspace paths, tools.deny, and plugin configs
  const pluginConfigs: Record<string, Record<string, Record<string, unknown>>> = {};
  let contextPluginAgents: Record<string, { tools: string[]; userId: string }> | undefined;

  const agentsList = allAgents.map((agent) => {
    const agentEntry: Record<string, unknown> = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      workspace: getOpenClawWorkspacePath(agent.id),
    };

    // Compute denied tool groups from allowed tools
    const allowedTools = (agent.allowedTools as string[]) || [];
    const deniedGroups = computeDeniedGroups(allowedTools);
    if (deniedGroups.length > 0) {
      agentEntry.tools = { deny: deniedGroups };
    }

    // Collect plugin config for agents that have file tools (pinchy_ls, pinchy_read)
    const hasFileTools = allowedTools.some((t: string) => t === "pinchy_ls" || t === "pinchy_read");
    if (hasFileTools && agent.pluginConfig) {
      if (!pluginConfigs["pinchy-files"]) {
        pluginConfigs["pinchy-files"] = {};
      }
      pluginConfigs["pinchy-files"][agent.id] = agent.pluginConfig as Record<string, unknown>;
    }

    // Collect plugin config for agents that have context tools (pinchy_save_*)
    const contextTools = allowedTools.filter((t: string) => t.startsWith("pinchy_save_"));
    if (contextTools.length > 0 && agent.ownerId) {
      if (!contextPluginAgents) {
        contextPluginAgents = {};
      }
      contextPluginAgents[agent.id] = {
        tools: contextTools.map((t: string) => t.replace("pinchy_", "")),
        userId: agent.ownerId,
      };
    }

    return agentEntry;
  });

  // Build complete config — gateway and OpenClaw-enriched fields preserved,
  // everything else from DB. OpenClaw adds meta, commands, etc. at startup;
  // removing them would cause unnecessary diffs on every write.
  //
  // Deep-merge agents into existing to preserve OpenClaw-enriched fields
  // (contextPruning, heartbeat, models, compaction) that may not yet be
  // in the config file right after a full restart.
  const existingAgents = (existing.agents as Record<string, unknown>) || {};
  const config: Record<string, unknown> = {
    gateway,
    env,
    agents: deepMerge(existingAgents, {
      defaults: pinchyDefaults,
      list: agentsList,
    }),
  };

  // Preserve OpenClaw-enriched top-level fields that Pinchy doesn't manage
  for (const key of ["meta", "commands"] as const) {
    if (existing[key] !== undefined) {
      config[key] = existing[key];
    }
  }

  const entries: Record<string, unknown> = {};
  for (const [pluginId, agentConfigs] of Object.entries(pluginConfigs)) {
    entries[pluginId] = {
      enabled: true,
      config: {
        agents: agentConfigs,
      },
    };
  }

  const gatewayAuth = (gateway as Record<string, unknown>).auth as
    | Record<string, unknown>
    | undefined;
  const gatewayToken = (gatewayAuth?.token as string) || "";

  // Only include pinchy-context when agents use it. Including disabled plugins
  // with config causes OpenClaw to spam "disabled in config but config is present".
  if (contextPluginAgents) {
    entries["pinchy-context"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken,
        agents: contextPluginAgents,
      },
    };
  }

  // Always include pinchy-audit and keep it enabled. It logs tool usage from
  // OpenClaw hooks so built-in and custom tools are captured at source.
  entries["pinchy-audit"] = {
    enabled: true,
    config: {
      apiBaseUrl: process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
      gatewayToken,
    },
  };

  // Note: pinchy-files is only included when agents use it (via pluginConfigs loop above).

  // Merge our plugin IDs into the existing allow list. OpenClaw adds its own
  // plugins (e.g. "telegram") to plugins.allow — if we overwrite the list,
  // OpenClaw sees a diff and triggers a full gateway restart every time.
  const existingAllow = ((existing.plugins as Record<string, unknown>)?.allow as string[]) || [];
  const ourPlugins = Object.keys(entries);
  const allowedPlugins = [...new Set([...existingAllow, ...ourPlugins])];

  if (allowedPlugins.length > 0 || Object.keys(entries).length > 0) {
    config.plugins = { allow: allowedPlugins, entries };
  }

  // Add Ollama cloud provider config when configured.
  // Must match OpenClaw's expected format exactly: apiKey + api mode + explicit models.
  const ollamaKey = await getSetting(PROVIDERS.ollama.settingsKey);
  if (ollamaKey) {
    (config as Record<string, unknown>).models = {
      providers: {
        "ollama-cloud": {
          baseUrl: "https://ollama.com/v1",
          apiKey: ollamaKey,
          api: "openai-completions",
          models: [
            {
              id: "gemini-3-flash-preview:cloud",
              name: "Gemini 3 Flash Preview",
              contextWindow: 1048576,
              maxTokens: 65536,
            },
            { id: "kimi-k2.5:cloud", name: "Kimi K2.5", contextWindow: 262144, maxTokens: 8192 },
            {
              id: "mistral-large-3:675b-cloud",
              name: "Mistral Large 3 675B",
              contextWindow: 131072,
              maxTokens: 8192,
            },
            {
              id: "qwen3.5:397b-cloud",
              name: "Qwen 3.5 397B",
              contextWindow: 262144,
              maxTokens: 8192,
            },
          ],
        },
      },
    };
  }

  // Build Telegram channel config from DB settings using OpenClaw's multi-account format.
  // Each agent with a bot token gets its own account. Bindings route via accountId.
  //
  // NOTE: allowFrom is NOT written here. It's managed via per-account allow-from
  // store files (credentials/telegram-<accountId>-allowFrom.json) to avoid
  // triggering the broken channel restart (openclaw/openclaw#47458).
  const accounts: Record<string, { botToken: string }> = {};
  interface TelegramBinding {
    agentId: string;
    match: { channel: string; accountId: string; peer?: { kind: string; id: string } };
  }
  const bindings: TelegramBinding[] = [];
  const personalBotsAccountIds: Array<{ accountId: string; ownerId: string | null }> = [];

  for (const agent of allAgents) {
    const botToken = await getSetting(`telegram_bot_token:${agent.id}`);
    if (botToken) {
      accounts[agent.id] = { botToken };
      if (agent.isPersonal) {
        // Personal agents: per-user peer bindings will be added below
        personalBotsAccountIds.push({ accountId: agent.id, ownerId: agent.ownerId });
      } else {
        // Shared agents: one generic binding per account
        bindings.push({ agentId: agent.id, match: { channel: "telegram", accountId: agent.id } });
      }
    }
  }

  if (Object.keys(accounts).length > 0) {
    const links = await db.select().from(channelLinks);
    const identityLinks: Record<string, string[]> = {};
    for (const link of links) {
      const identity = `${link.channel}:${link.channelUserId}`;
      if (!identityLinks[link.userId]) {
        identityLinks[link.userId] = [identity];
      } else {
        identityLinks[link.userId].push(identity);
      }
    }

    // Build per-user peer bindings for personal agents (e.g. Smithers).
    // Each linked user's DMs are routed to THEIR personal agent, not the
    // bot owner's agent. This ensures Telegram conversations match the
    // user's personal Smithers in the web UI.
    if (personalBotsAccountIds.length > 0) {
      const telegramLinks = links.filter((l) => l.channel === "telegram");
      // Map userId → their personal agent ID (hoisted outside loop)
      const personalAgentsByOwner = new Map(
        allAgents.filter((a) => a.isPersonal && !a.deletedAt).map((a) => [a.ownerId, a.id])
      );

      for (const { accountId } of personalBotsAccountIds) {
        for (const link of telegramLinks) {
          // Route to user's own personal agent, or fall back to the bot owner's agent
          const targetAgentId = personalAgentsByOwner.get(link.userId) || accountId;
          bindings.push({
            agentId: targetAgentId,
            match: {
              channel: "telegram",
              accountId,
              peer: { kind: "dm", id: link.channelUserId },
            },
          });
        }
      }
    }

    // Preserve OpenClaw-enriched channel fields (groupPolicy, streaming)
    const existingTelegram =
      ((existing.channels as Record<string, unknown>)?.telegram as Record<string, unknown>) || {};
    config.channels = {
      telegram: {
        ...existingTelegram,
        dmPolicy: "pairing",
        accounts,
      },
    };
    config.bindings = bindings;
    config.session = {
      dmScope: "per-peer",
      ...(Object.keys(identityLinks).length > 0 && { identityLinks }),
    };
  }

  // Only write if content actually changed — prevents unnecessary OpenClaw restarts
  const newContent = JSON.stringify(config, null, 2);
  try {
    const existing = readFileSync(CONFIG_PATH, "utf-8");
    if (existing === newContent) return;
  } catch {
    // File doesn't exist yet — write it
  }

  writeConfigAtomic(newContent);
}

// ── Targeted config updates ───────────────────────────────────────────────

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

  const session = (existing.session as Record<string, unknown>) || {};
  const updatedSession = {
    ...session,
    identityLinks,
  };

  const updated = { ...existing, session: updatedSession };

  // Only write if content actually changed
  const newContent = JSON.stringify(updated, null, 2);
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

  if (accountId && account) {
    // Add/update account
    const existingTelegram =
      ((existing.channels as Record<string, unknown>)?.telegram as Record<string, unknown>) || {};
    const existingAccounts = (existingTelegram.accounts as Record<string, unknown>) || {};

    existingAccounts[accountId] = account;

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
    // Remove specific account
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

  const newContent = JSON.stringify(existing, null, 2);
  try {
    const current = readFileSync(CONFIG_PATH, "utf-8");
    if (current === newContent) return;
  } catch {
    // File doesn't exist
  }

  writeConfigAtomic(newContent);
}
