import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { db } from "@/db";
import { agents, channelLinks } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { computeDeniedGroups } from "@/lib/tool-registry";
import { getOpenClawWorkspacePath } from "@/lib/workspace";
import { restartState } from "@/server/restart-state";
import { migrateExistingSmithers } from "@/lib/migrate-onboarding";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

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

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o644 });
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

  // Read default provider to set defaults.model
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const defaults: Record<string, unknown> = {};
  if (defaultProvider && PROVIDERS[defaultProvider]) {
    defaults.model = { primary: PROVIDERS[defaultProvider].defaultModel };
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

  // Build complete config — gateway preserved, everything else from DB
  const config: Record<string, unknown> = {
    gateway,
    env,
    agents: {
      defaults,
      list: agentsList,
    },
  };

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

  // Set plugins.allow to only the enabled plugin IDs. This prevents OpenClaw from
  // auto-discovering unused plugins from the extensions directory, which would cause
  // either a restart loop (invalid config) or "disabled but config present" warning spam.
  const allowedPlugins = Object.keys(entries);

  if (Object.keys(entries).length > 0) {
    config.plugins = { allow: allowedPlugins, entries };
  }

  // Build Telegram channel config from DB settings
  // For now: single bot token (first configured agent wins).
  // Multi-bot via OpenClaw accounts is a future enhancement.
  for (const agent of allAgents) {
    const botToken = await getSetting(`telegram_bot_token:${agent.id}`);
    if (botToken) {
      const links = await db.select().from(channelLinks);
      const allowFrom: string[] = [];
      const identityLinks: Record<string, string[]> = {};
      for (const link of links) {
        if (link.channel === "telegram") {
          allowFrom.push(link.channelUserId);
          identityLinks[link.userId] = [`telegram:${link.channelUserId}`];
        }
      }

      config.channels = {
        telegram: {
          enabled: true,
          botToken,
          dmPolicy: "pairing",
          ...(allowFrom.length > 0 && { allowFrom }),
        },
      };
      config.bindings = [{ agentId: agent.id, match: { channel: "telegram" } }];
      config.session = {
        dmScope: "per-peer",
        ...(Object.keys(identityLinks).length > 0 && { identityLinks }),
      };
      break;
    }
  }

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Only write if content actually changed — prevents unnecessary OpenClaw restarts
  // (inotifywait on the config file triggers a restart on every write)
  const newContent = JSON.stringify(config, null, 2);
  try {
    const existing = readFileSync(CONFIG_PATH, "utf-8");
    if (existing === newContent) return;
  } catch {
    // File doesn't exist yet — write it
  }

  writeFileSync(CONFIG_PATH, newContent, { encoding: "utf-8", mode: 0o644 });
  restartState.notifyRestart();
}

// ── Types for config patch helpers ────────────────────────────────────────

type PatchResult = { applied: true } | { applied: false; error: string };

interface ConfigClient {
  config: {
    get: () => Promise<Record<string, unknown>>;
    patch: (raw: string, baseHash: string) => Promise<unknown>;
  };
}

// ── pushStartupConfig ────────────────────────────────────────────────────

/**
 * Read the config file and push it to OpenClaw via config.patch.
 *
 * Called once on first WebSocket connect to close the startup gap: if OpenClaw
 * started before Pinchy wrote the config, it has an outdated version. This
 * pushes the full config as a patch so channels, bindings, and session are
 * applied without requiring a manual restart.
 */
export async function pushStartupConfig(client: ConfigClient): Promise<PatchResult> {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return applyConfigPatch(client, config);
  } catch (err) {
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── applyConfigPatch ─────────────────────────────────────────────────────

/**
 * Apply a config.patch to OpenClaw with hash-conflict retry.
 *
 * - Timeout/disconnect is treated as success (OpenClaw restarts after applying channel changes)
 * - Hash conflicts retry once (another config change may have raced)
 * - Other failures return { applied: false } — the change is safe in DB
 *   and will be picked up on next restart via regenerateOpenClawConfig
 */
export async function applyConfigPatch(
  client: ConfigClient,
  patchData: Record<string, unknown>
): Promise<PatchResult> {
  const raw = JSON.stringify(patchData);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const configResult = await client.config.get();
      const hash = configResult.hash as string;
      await client.config.patch(raw, hash);
      return { applied: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Timeout/disconnect = OpenClaw restarted after applying the patch
      if (
        message.includes("timed out") ||
        message.includes("disconnect") ||
        message.includes("closed")
      ) {
        return { applied: true };
      }

      // Hash conflict = another config change raced. Retry once.
      if (message.includes("hash") && attempt === 0) {
        continue;
      }

      return { applied: false, error: message };
    }
  }

  return { applied: false, error: "hash_mismatch" };
}

// ── queueConfigPatch ─────────────────────────────────────────────────────

const DEBOUNCE_MS = 2000;
let pendingPatch: Record<string, unknown> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue a config patch with debounce. Rapid patches (e.g. bot setup + pairing)
 * are deep-merged and applied as a single config.patch after a 2-second window.
 */
export function queueConfigPatch(client: ConfigClient, patchData: Record<string, unknown>) {
  if (pendingPatch) {
    pendingPatch = deepMerge(pendingPatch, patchData);
  } else {
    pendingPatch = { ...patchData };
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    const patch = pendingPatch;
    pendingPatch = null;
    debounceTimer = null;
    if (patch) {
      applyConfigPatch(client, patch);
    }
  }, DEBOUNCE_MS);
}

/** Reset queue state (for testing only). */
export function _resetQueue() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  pendingPatch = null;
  debounceTimer = null;
}
