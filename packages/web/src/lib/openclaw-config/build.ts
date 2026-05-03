import { readFileSync } from "fs";
import { writeSecretsFile, secretRef, type SecretsBundle } from "@/lib/openclaw-secrets";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { getDefaultModel } from "@/lib/provider-models";
import { eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  agentConnectionPermissions,
  integrationConnections,
  channelLinks,
} from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { computeDeniedGroups } from "@/lib/tool-registry";
import type { AgentPluginConfig } from "@/db/schema";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS, OLLAMA_CLOUD_COST } from "@/lib/ollama-cloud-models";
import { getOpenClawWorkspacePath } from "@/lib/workspace";
import { migrateExistingSmithers } from "@/lib/migrate-onboarding";

import { CONFIG_PATH } from "./paths";
import { configsAreEquivalentUpToOpenClawMetadata } from "./normalize";
import { writeConfigAtomic, readExistingConfig, pushConfigInBackground } from "./write";
import {
  buildSecretsBundle,
  collectProviderSecrets,
  readGatewayTokenFromConfig,
} from "./secrets-bundle";

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

export async function regenerateOpenClawConfig() {
  // Migrate existing Smithers agents first, so their updated allowedTools
  // are reflected in the config we're about to generate.
  await migrateExistingSmithers();

  const existing = readExistingConfig();

  // Build the gateway block. mode and bind are always set. auth.token is written
  // as a plain string — OpenClaw requires a literal string for gateway auth and
  // does not resolve SecretRef objects in the gateway.auth block.
  // The same token is also written to secrets.json so Pinchy can read it.
  const existingGateway = (existing.gateway as Record<string, unknown>) || {};
  const gatewayTokenValue = readGatewayTokenFromConfig(existing);
  if (!gatewayTokenValue) {
    // Either ensure-gateway-token.js hasn't run yet (first start), or the
    // OpenClaw container is broken. Logging instead of throwing so a fresh
    // setup can recover once the token appears in secrets.json on the next
    // regenerateOpenClawConfig() pass.
    console.warn(
      "[openclaw-config] No gateway token found in existing config or secrets.json. " +
        "Writing empty token — OpenClaw auth will reject requests until the token is provisioned."
    );
  }

  const gateway: Record<string, unknown> = {
    ...existingGateway,
    mode: "local",
    bind: "lan",
    auth: {
      mode: "token",
      token: gatewayTokenValue || "",
    },
  };

  // Read all agents from DB
  const allAgents = await db.select().from(agents);

  // Pattern A from CLAUDE.md "Secrets Handling": env-template + secret pair
  // for each LLM provider with a configured apiKey. Helper returns fresh
  // mutable maps; ollama-cloud is spliced into providerSecrets later
  // (it uses SecretRef, not an env template, and is therefore handled
  // at the model-providers call site).
  const {
    envTemplates: env,
    providers: providerSecrets,
    envSecrets,
  } = await collectProviderSecrets();

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
      // Disable heartbeat by default: it fires LLM calls in the background
      // and racks up tokens even for idle agents. Set per-agent (NOT in
      // agents.defaults) to avoid hot-reload races with Telegram (openclaw#47458).
      heartbeat: { every: "0m" },
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
      const filesConfig = (agent.pluginConfig as AgentPluginConfig)?.["pinchy-files"];
      if (filesConfig) {
        if (!pluginConfigs["pinchy-files"]) {
          pluginConfigs["pinchy-files"] = {};
        }
        pluginConfigs["pinchy-files"][agent.id] = filesConfig as Record<string, unknown>;
      }
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
    // Disable OpenClaw's mDNS announcer. Pinchy always runs OpenClaw inside
    // a container; multicast doesn't route out of Docker bridge networks,
    // so the announcer hangs in `state=announcing`. After ~16 s OpenClaw's
    // internal Bonjour watchdog declares the service stuck and SIGTERMs the
    // gateway, costing ~30 s of "Reconnecting to the agent…" downtime per
    // cold start (observed staging 2026-05-03; see openclaw-integration.log
    // entries `[bonjour] restarting advertiser (service stuck in announcing)`).
    // We connect via OPENCLAW_WS_URL on the bridge network and never need
    // mDNS, so turning it off is safe.
    discovery: { mdns: { mode: "off" } },
    env,
    secrets: {
      providers: {
        pinchy: {
          source: "file",
          // OPENCLAW_SECRETS_PATH_IN_OPENCLAW lets integration tests bind-mount
          // the secrets file at a different path inside the OpenClaw container
          // than the one Pinchy writes from the host. In production both
          // containers share the same tmpfs volume, so OPENCLAW_SECRETS_PATH is
          // sufficient and OPENCLAW_SECRETS_PATH_IN_OPENCLAW stays unset.
          path:
            process.env.OPENCLAW_SECRETS_PATH_IN_OPENCLAW ||
            process.env.OPENCLAW_SECRETS_PATH ||
            "/openclaw-secrets/secrets.json",
          mode: "json",
        },
      },
    },
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

  // Write gateway token to secrets.json so Pinchy can read it at startup from secrets.json
  const gatewaySecret = gatewayTokenValue ? { token: gatewayTokenValue } : undefined;

  // OpenClaw 2026.4.26 does not resolve SecretRef in plugins.entries.*.config —
  // the validator rejects the config with "gatewayToken: invalid config: must be
  // string". We therefore inline the plain token in plugin configs. Can move to
  // SecretRef once we upgrade OpenClaw to a version that resolves them here.
  const gatewayTokenString = gatewayTokenValue || "";

  // pinchy-files needs apiBaseUrl/gatewayToken so it can report vision API
  // token usage (from scanned-PDF processing) back to Pinchy via
  // /api/internal/usage/record. Unlike pinchy-context which only exposes
  // per-agent `agents`, pinchy-files adds the two top-level keys alongside.
  if (pluginConfigs["pinchy-files"]) {
    entries["pinchy-files"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
        agents: pluginConfigs["pinchy-files"],
      },
    };
  }

  // Any additional plugins collected via pluginConfigs get the generic
  // shape (no apiBaseUrl/gatewayToken). Today this branch is empty; it
  // exists to keep the pluginConfigs abstraction for future per-agent plugins.
  for (const [pluginId, agentConfigs] of Object.entries(pluginConfigs)) {
    if (pluginId === "pinchy-files") continue;
    entries[pluginId] = {
      enabled: true,
      config: {
        agents: agentConfigs,
      },
    };
  }

  // Enable pinchy-docs for all personal agents (Smithers) so they can read
  // platform documentation on demand. The plugin scopes itself to listed agents.
  const personalAgentIds = allAgents.filter((a) => a.isPersonal && !a.deletedAt).map((a) => a.id);
  if (personalAgentIds.length > 0) {
    entries["pinchy-docs"] = {
      enabled: true,
      config: {
        docsPath: "/pinchy-docs",
        agents: Object.fromEntries(personalAgentIds.map((id) => [id, {}])),
      },
    };
  }

  // Only include pinchy-context when agents use it. Including disabled plugins
  // with config causes OpenClaw to spam "disabled in config but config is present".
  if (contextPluginAgents) {
    entries["pinchy-context"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
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
      gatewayToken: gatewayTokenString,
    },
  };

  // Note: pinchy-files is only included when agents use it (via pluginConfigs loop above).

  // Collect Odoo integration configs for agents with integration permissions
  // Only include active connections — pending ones have no usable credentials
  const allPermissions = await db
    .select()
    .from(agentConnectionPermissions)
    .innerJoin(
      integrationConnections,
      eq(agentConnectionPermissions.connectionId, integrationConnections.id)
    )
    .where(ne(integrationConnections.status, "pending"));

  const odooAgentConfigs: Record<string, Record<string, unknown>> = {};
  const integrationSecrets: SecretsBundle["integrations"] = {};
  const permsByAgent = new Map<
    string,
    Map<
      string,
      { connection: typeof integrationConnections.$inferSelect; ops: Map<string, string[]> }
    >
  >();

  for (const row of allPermissions) {
    const perm = row.agent_connection_permissions;
    const conn = row.integration_connections;

    if (conn.type !== "odoo") continue;

    if (!permsByAgent.has(perm.agentId)) {
      permsByAgent.set(perm.agentId, new Map());
    }
    const agentPerms = permsByAgent.get(perm.agentId)!;

    if (!agentPerms.has(perm.connectionId)) {
      agentPerms.set(perm.connectionId, { connection: conn, ops: new Map() });
    }
    const connPerms = agentPerms.get(perm.connectionId)!;

    if (!connPerms.ops.has(perm.model)) {
      connPerms.ops.set(perm.model, []);
    }
    connPerms.ops.get(perm.model)!.push(perm.operation);
  }

  // Build plugin config per agent (using first connection — single connection per agent for now)
  for (const [agentId, connections] of permsByAgent) {
    const [firstConnection] = connections.values();
    if (!firstConnection) continue;

    const conn = firstConnection.connection;

    const permissions: Record<string, string[]> = {};
    for (const [model, ops] of firstConnection.ops) {
      permissions[model] = ops;
    }

    // Build lightweight model name map — only for models with permissions
    // (no field schemas — those are fetched live by the plugin via fields_get())
    const modelNames: Record<string, string> = {};
    if (conn.data && typeof conn.data === "object") {
      const data = conn.data as {
        models?: Array<{ model: string; name: string }>;
      };
      if (data.models) {
        for (const m of data.models) {
          if (permissions[m.model]) {
            modelNames[m.model] = m.name;
          }
        }
      }
    }

    // No credentials in plugin config. The plugin fetches them on demand
    // from /api/internal/integrations/<connectionId>/credentials with the
    // gateway token. See packages/plugins/pinchy-odoo/index.ts and
    // packages/web/src/app/api/internal/integrations/[connectionId]/credentials/route.ts.
    // This keeps openclaw.json free of long-lived per-tenant secrets and
    // lets Pinchy own rotation, audit, and per-agent authorization
    // centrally — same pattern as pinchy-email. See #209 for the bug
    // that motivated the migration away from SecretRef-in-plugin-config.
    odooAgentConfigs[agentId] = {
      connectionId: conn.id,
      permissions,
      modelNames,
    };
  }

  if (Object.keys(odooAgentConfigs).length > 0) {
    entries["pinchy-odoo"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
        agents: odooAgentConfigs,
      },
    };
  }

  // Collect web search configs
  const webSearchConnections = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.type, "web-search"));

  if (webSearchConnections.length > 0) {
    const webConn = webSearchConnections[0];

    const webAgentConfigs: Record<string, Record<string, unknown>> = {};

    for (const agent of allAgents) {
      const allowedTools = (agent.allowedTools as string[]) || [];
      const hasWebSearch = allowedTools.includes("pinchy_web_search");
      const hasWebFetch = allowedTools.includes("pinchy_web_fetch");

      if (hasWebSearch || hasWebFetch) {
        const webConfig = (agent.pluginConfig as AgentPluginConfig)?.["pinchy-web"] ?? {};
        const tools: string[] = [];
        if (hasWebSearch) tools.push("pinchy_web_search");
        if (hasWebFetch) tools.push("pinchy_web_fetch");

        webAgentConfigs[agent.id] = { tools, ...webConfig };
      }
    }

    if (Object.keys(webAgentConfigs).length > 0) {
      // No braveApiKey in plugin config. The plugin fetches it on demand
      // from the credentials API — same pattern as pinchy-odoo / pinchy-email.
      // See #209 for the bug class motivated this migration.
      entries["pinchy-web"] = {
        enabled: true,
        config: {
          apiBaseUrl:
            process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
          gatewayToken: gatewayTokenString,
          connectionId: webConn.id,
          agents: webAgentConfigs,
        },
      };
    }
  }

  // Collect email integration configs for agents with email provider permissions.
  // Unlike Odoo, email config does NOT include decrypted credentials — only
  // connectionId + permissions. The plugin fetches credentials at runtime via
  // the internal API (API-callback pattern).
  const EMAIL_PROVIDER_TYPES = new Set(["google", "microsoft", "imap"]);
  const emailPermsByAgent = new Map<string, { connectionId: string; ops: Map<string, string[]> }>();

  for (const row of allPermissions) {
    const perm = row.agent_connection_permissions;
    const conn = row.integration_connections;

    if (!EMAIL_PROVIDER_TYPES.has(conn.type)) continue;

    if (!emailPermsByAgent.has(perm.agentId)) {
      emailPermsByAgent.set(perm.agentId, {
        connectionId: perm.connectionId,
        ops: new Map(),
      });
    }
    const agentPerms = emailPermsByAgent.get(perm.agentId)!;

    if (!agentPerms.ops.has(perm.model)) {
      agentPerms.ops.set(perm.model, []);
    }
    agentPerms.ops.get(perm.model)!.push(perm.operation);
  }

  const emailAgentConfigs: Record<
    string,
    { connectionId: string; permissions: Record<string, string[]> }
  > = {};
  for (const [agentId, data] of emailPermsByAgent) {
    const permissions: Record<string, string[]> = {};
    for (const [model, ops] of data.ops) {
      permissions[model] = ops;
    }
    emailAgentConfigs[agentId] = {
      connectionId: data.connectionId,
      permissions,
    };
  }

  if (Object.keys(emailAgentConfigs).length > 0) {
    entries["pinchy-email"] = {
      enabled: true,
      config: {
        apiBaseUrl:
          process.env.PINCHY_INTERNAL_URL || `http://pinchy:${process.env.PORT || "7777"}`,
        gatewayToken: gatewayTokenString,
        agents: emailAgentConfigs,
      },
    };
  }

  // Build the allow list. Two requirements:
  //   1. Include every plugin we have entries for (pinchy-*) and every
  //      OpenClaw-managed plugin (e.g. "telegram") already in the list.
  //   2. Preserve the existing positional order. OpenClaw treats
  //      `plugins.allow` as restart-required: a reorder triggers a full
  //      gateway restart even when the SET of plugins is unchanged. The
  //      previous implementation rebuilt allow as
  //      `[...existing-non-pinchy, ...our-pinchy-in-insertion-order]`,
  //      which reshuffles the array whenever OpenClaw appended one of its
  //      managed plugins after Pinchy's first write (e.g. `telegram` after
  //      `connectBot`). The next regenerate then moved telegram to position 0
  //      and re-ordered pinchy-* entries — same set, restart cascade. See #237.
  // We must NOT include Pinchy plugins without entries — OpenClaw validates
  // their config schema and rejects missing required fields like "agents".
  const existingAllow = ((existing.plugins as Record<string, unknown>)?.allow as string[]) || [];
  const ourPlugins = new Set(Object.keys(entries));
  const pinchyPluginPrefixes = ["pinchy-"];
  const isPinchyPlugin = (p: string) => pinchyPluginPrefixes.some((prefix) => p.startsWith(prefix));
  const isWanted = (p: string) => !isPinchyPlugin(p) || ourPlugins.has(p);
  // Keep existing entries (in their current positions) that we still want.
  // Drops stale pinchy-* entries we no longer emit; preserves OpenClaw-
  // managed plugins as-is.
  const preservedOrder: string[] = [];
  const seen = new Set<string>();
  for (const plugin of existingAllow) {
    if (isWanted(plugin) && !seen.has(plugin)) {
      preservedOrder.push(plugin);
      seen.add(plugin);
    }
  }
  // Append any pinchy-* plugin newly added since the last write. New
  // additions go at the end so the positions of pre-existing entries stay
  // stable (no spurious diff for unrelated plugins).
  const newAdditions = [...ourPlugins].filter((p) => !seen.has(p));
  const allowedPlugins = [...preservedOrder, ...newAdditions];

  // Preserve OpenClaw-managed plugin entries that we don't write ourselves.
  // OpenClaw auto-enables each configured provider (anthropic, openai, google,
  // ollama-cloud) and the telegram channel by writing
  // `plugins.entries.<id> = { enabled: true }` into openclaw.json on startup.
  // Without this preservation the next regenerate strips those entries,
  // OpenClaw treats it as a config diff and triggers a full gateway restart
  // (15-30 s downtime, "Agent runtime is not available" banner — #193).
  // Same root cause as the channels.telegram.enabled fix above; this covers
  // the plugins.entries.* surface.
  const existingEntries =
    ((existing.plugins as Record<string, unknown>)?.entries as Record<string, unknown>) || {};
  for (const [pluginId, entry] of Object.entries(existingEntries)) {
    if (!isPinchyPlugin(pluginId) && !(pluginId in entries)) {
      entries[pluginId] = entry;
    }
  }

  if (allowedPlugins.length > 0 || Object.keys(entries).length > 0) {
    config.plugins = { allow: allowedPlugins, entries };
  }

  // Build models.providers block for Ollama providers
  const ollamaCloudKey = await getSetting(PROVIDERS["ollama-cloud"].settingsKey);
  const ollamaLocalUrl = await getSetting(PROVIDERS["ollama-local"].settingsKey);

  const modelProviders: Record<string, unknown> = {};

  if (ollamaCloudKey) {
    providerSecrets["ollama-cloud"] = { apiKey: ollamaCloudKey };
    modelProviders["ollama-cloud"] = {
      baseUrl: "https://ollama.com/v1",
      apiKey: secretRef("/providers/ollama-cloud/apiKey"),
      api: "openai-completions",
      // Derived from TOOL_CAPABLE_OLLAMA_CLOUD_MODELS — see that file for
      // the source of each capability (ollama.com/library/<name>).
      //
      // `compat.supportsUsageInStreaming: true` is REQUIRED for usage
      // tracking. OpenClaw's default compat detection treats any configured
      // non-OpenAI endpoint as not supporting usage-in-streaming, so it
      // never sends `stream_options: { include_usage: true }`. Ollama Cloud
      // only emits the final usage chunk when that flag is present — without
      // this opt-in, every session has zero tracked tokens and Usage & Costs
      // stays empty. Verified live against https://ollama.com/v1/chat/completions.
      //
      // `reasoning`, `input`, and `cost` are required fields of OpenClaw's
      // ModelDefinitionConfig. Cost is zero because Ollama Cloud bills by
      // subscription plan, not per token — a fabricated rate would mislead
      // users reading the Usage dashboard.
      models: TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.map((m) => ({
        id: m.id,
        name: m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
        input: m.vision ? ["text", "image"] : ["text"],
        cost: { ...OLLAMA_CLOUD_COST },
        compat: { supportsUsageInStreaming: true },
      })),
    };
  }

  if (ollamaLocalUrl) {
    modelProviders["ollama"] = {
      baseUrl: ollamaLocalUrl.replace(/\/$/, ""),
      api: "ollama",
      models: [], // Empty array — OpenClaw requires it for config validation, auto-discovers models at runtime
    };
  }

  if (Object.keys(modelProviders).length > 0) {
    (config as Record<string, unknown>).models = { providers: modelProviders };
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

    // Preserve OpenClaw-enriched channel fields (groupPolicy, streaming, enabled).
    // Use an explicit allow-list instead of spread to prevent unknown/legacy
    // fields (including potential legacy secrets) from leaking into the config.
    // `enabled` is on the list because OpenClaw writes back `"enabled": true`
    // whenever Telegram is auto-enabled at gateway startup. Without it on the
    // list, the next regenerate strips the field, OpenClaw treats that as a
    // config diff and triggers a full gateway restart, the restart re-runs
    // auto-enable and re-adds the field — endless ping-pong loop where every
    // settings save costs 15-30 s of "Agent runtime is not available"
    // downtime (#193).
    const existingTelegram =
      ((existing.channels as Record<string, unknown>)?.telegram as Record<string, unknown>) || {};
    const ENRICHED_TELEGRAM_FIELDS = ["groupPolicy", "streaming"] as const;
    const preservedTelegram: Record<string, unknown> = {};
    for (const f of ENRICHED_TELEGRAM_FIELDS) {
      if (f in existingTelegram) preservedTelegram[f] = existingTelegram[f];
    }
    // Defense in depth: write `enabled: true` actively when we emit the
    // telegram block at all. Pinchy's source of truth is "telegram has
    // ≥1 account configured" → channels.telegram block is emitted; "no
    // accounts" → block is deleted (further down). So whenever the block
    // exists, it should be enabled. Without this active write, the field's
    // presence depends on OpenClaw's auto-enable side-effect having run
    // first, and any regenerate before that side-effect fires would strip
    // it and trigger the ping-pong.
    config.channels = {
      telegram: { ...preservedTelegram, enabled: true, dmPolicy: "pairing", accounts },
    };
    config.bindings = bindings;
    config.session = {
      dmScope: "per-peer",
      ...(Object.keys(identityLinks).length > 0 && { identityLinks }),
    };
  }

  // Always write secrets.json — tmpfs is wiped on container restart, secrets.json
  // must be present for OpenClaw to resolve SecretRef pointers (provider API keys etc.).
  const secretsBundle = buildSecretsBundle({
    gateway: gatewaySecret,
    providers: providerSecrets,
    integrations: integrationSecrets,
    env: envSecrets,
  });
  writeSecretsFile(secretsBundle);

  // Only write if content actually changed — prevents unnecessary OpenClaw restarts.
  // Format must match what OpenClaw's writeConfigFile produces (trimEnd + "\n")
  // so the SHA256 hashes line up. OpenClaw's reload subsystem dedupes
  // chokidar-fired reloads against `lastAppliedWriteHash` (set when
  // config.apply runs); if our file hash equals the apply's hash, the
  // chokidar reload is correctly skipped. Without the trailing newline,
  // hashes diverge and chokidar fires a redundant reload that diffs against
  // a stale `currentCompareConfig` — see #193 / openclaw#75534.
  const newContent = JSON.stringify(config, null, 2).trimEnd() + "\n";
  try {
    const existing = readFileSync(CONFIG_PATH, "utf-8");
    if (existing === newContent) return;
    // Workaround for openclaw#75534: OpenClaw stamps `meta.lastTouchedAt`
    // on every write it performs (config.apply RPC, internal restart
    // bookkeeping). Pinchy preserves `meta` from existing, so back-to-back
    // regenerates with no DB changes still differ on this single field.
    // Without this normalize-compare, sending the byte-different config
    // via config.apply triggers OpenClaw's diff-against-runtime-resolved-
    // snapshot to flag env.* paths as changed (env templates "${VAR}" vs
    // resolved "sk-..."), which falls through `BASE_RELOAD_RULES` to the
    // default full-restart trigger. Result: every settings save costs
    // 15-30 s of "Agent runtime is not available" downtime (#193).
    // Removable when we bump OpenClaw past the upstream fix; tracked in #215.
    if (configsAreEquivalentUpToOpenClawMetadata(existing, newContent)) return;
  } catch {
    // File doesn't exist yet — write it
  }

  // The file is the canonical source of truth. OpenClaw's inotify watcher
  // will eventually pick it up — slowly on production volumes (~60 s),
  // which is the latency `pushConfigInBackground` exists to hide.
  writeConfigAtomic(newContent);

  // Best-effort RPC push for faster runtime propagation. Fire-and-forget:
  // the user-visible POST that triggered this regenerate must return as
  // soon as the file is on disk, since `config.apply` can block 10–30 s
  // when the change requires a gateway restart. Blocking that long broke
  // interactive save flows (Odoo permissions Save & Restart, where the
  // UI waits for "All changes saved").
  pushConfigInBackground(newContent);
}
