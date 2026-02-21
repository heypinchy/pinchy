import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { computeDeniedGroups } from "@/lib/tool-registry";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
const OPENCLAW_WORKSPACE_PREFIX =
  process.env.OPENCLAW_WORKSPACE_PREFIX || "/root/.openclaw/workspaces";

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

  const pinchyFields = {
    gateway: { mode: "local", bind: "lan" },
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

  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}

export async function regenerateOpenClawConfig() {
  const existing = readExistingConfig();

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

  const agentsList = allAgents.map((agent) => {
    const agentEntry: Record<string, unknown> = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      workspace: `${OPENCLAW_WORKSPACE_PREFIX}/${agent.id}`,
    };

    // Compute denied tool groups from allowed tools
    const allowedTools = (agent.allowedTools as string[]) || [];
    const deniedGroups = computeDeniedGroups(allowedTools);
    if (deniedGroups.length > 0) {
      agentEntry.tools = { deny: deniedGroups };
    }

    // Collect plugin config for agents that have safe (pinchy_*) tools
    const hasSafeTools = allowedTools.some((t: string) => t.startsWith("pinchy_"));
    if (hasSafeTools && agent.pluginConfig) {
      if (!pluginConfigs["pinchy-files"]) {
        pluginConfigs["pinchy-files"] = {};
      }
      pluginConfigs["pinchy-files"][agent.id] = agent.pluginConfig as Record<string, unknown>;
    }

    return agentEntry;
  });

  // Build plugins section if any agents use plugins
  const pinchyFields: Record<string, unknown> = {
    gateway: { mode: "local", bind: "lan" },
    env,
    agents: {
      defaults,
      list: agentsList,
    },
  };

  if (Object.keys(pluginConfigs).length > 0) {
    const entries: Record<string, unknown> = {};
    for (const [pluginId, agentConfigs] of Object.entries(pluginConfigs)) {
      entries[pluginId] = {
        enabled: true,
        config: {
          agents: agentConfigs,
        },
      };
    }
    pinchyFields.plugins = { entries };
  }

  const merged = deepMerge(existing, pinchyFields);

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}
