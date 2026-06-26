import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  const renameSyncMock = vi.fn();
  const chmodSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      renameSync: renameSyncMock,
      chmodSync: chmodSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
    chmodSync: chmodSyncMock,
  };
});

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    })),
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  // regenerateOpenClawConfig walks getOrCreateEncryptionKey() +
  // getOrCreatePluginSecret() that both call setSetting from
  // @/lib/settings when no prior value exists.
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

// Main introduced an ensureModelCapabilityCacheLoaded() call inside
// regenerateOpenClawConfig (for PDF/image model selection). Its db.select()
// for the `models` table would otherwise consume the first slot in our
// hand-counted db-select mock chain below and shift every fixture by one.
// Stub it to a no-op so our setupDbMock counter still starts at `agents`.
vi.mock("@/lib/model-capabilities/cache", () => ({
  ensureModelCapabilityCacheLoaded: vi.fn().mockResolvedValue(undefined),
  loadModelCapabilityCache: vi.fn().mockResolvedValue(undefined),
  invalidateModelCapabilityCache: vi.fn(),
  getModelCapabilities: vi.fn().mockReturnValue(null),
  modelHasCapability: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => val,
  encrypt: (val: string) => val,
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/migrate-onboarding", () => ({
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw-secrets")>();
  return {
    ...actual,
    writeSecretsFile: vi.fn(),
    readSecretsFile: vi.fn().mockReturnValue({}),
  };
});

vi.mock("@/lib/provider-models", () => {
  const defaults: Record<string, string> = {
    anthropic: "anthropic/claude-haiku-4-5-20251001",
  };
  return {
    getDefaultModel: vi.fn(async (provider: string) => defaults[provider] ?? ""),
  };
});

import { writeFileSync, readFileSync, existsSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { mcpServerKey, nativeMcpToolName } from "@/lib/openclaw-config/native-mcp";
import { db } from "@/db";
import { getSetting } from "@/lib/settings";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedDb = vi.mocked(db);
const mockedGetSetting = vi.mocked(getSetting);

const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

// Default toolset used when a test doesn't override `tools` — covers all
// tool names referenced by makeMcpPerm in this file.
const DEFAULT_TEST_TOOLS = [
  { name: "create_issue", description: "Create issue", inputSchema: { type: "object" } },
  { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
  { name: "search_pages", description: "Search pages", inputSchema: { type: "object" } },
];

// Helper: build an MCP integration connection row
function makeMcpConnection(
  overrides: Partial<{
    id: string;
    name: string;
    preset: string;
    transport: string;
    url: string;
    // Note: toolPrefix is no longer persisted on `data` — build.ts resolves
    // it from the preset registry. The override is accepted for back-compat
    // but ignored by build.ts.
    toolPrefix: string;
    status: string;
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  }> = {}
) {
  const {
    id = "conn-mcp-1",
    name = "My GitHub MCP",
    preset = "github",
    transport = "http",
    url = "https://api.githubcopilot.com/mcp/",
    status = "active",
    tools = DEFAULT_TEST_TOOLS,
  } = overrides;
  return {
    id,
    name,
    type: "mcp" as const,
    description: "",
    // credentials is AES-256-GCM encrypted JSON — never put in plugin config
    credentials: JSON.stringify({ token: "ghp_secret_leaked" }),
    data: { preset, transport, url, tools, lastSyncAt: new Date().toISOString() },
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Helper: build an agent row
function makeAgent(
  overrides: Partial<{
    id: string;
    name: string;
    model: string;
    allowedTools: string[];
    isPersonal: boolean;
    ownerId: string | null;
  }> = {}
) {
  return {
    id: overrides.id ?? "agent-1",
    name: overrides.name ?? "Test Agent",
    model: overrides.model ?? "anthropic/claude-haiku-4-5-20251001",
    allowedTools: overrides.allowedTools ?? [],
    pluginConfig: null,
    isPersonal: overrides.isPersonal ?? false,
    ownerId: overrides.ownerId ?? null,
    deletedAt: null,
    createdAt: new Date(),
  };
}

// Helper: build an agentMcpToolPermissions row
function makeMcpPerm(agentId: string, connectionId: string, toolName: string) {
  return {
    id: `perm-${agentId}-${toolName}`,
    agentId,
    connectionId,
    toolName,
    createdAt: new Date(),
  };
}

/**
 * Sets up the db.select mock to return the right data for each call in order.
 *
 * Call order in regenerateOpenClawConfig:
 *   1. db.select().from(agents) → agentsData
 *   2. db.select().from(agentConnectionPermissions).innerJoin(...).where(...) → []
 *   3. db.select().from(integrationConnections).where(type = 'web-search') → []
 *   4. db.select().from(integrationConnections).where(and(type='mcp', status='active')) → mcpConnections
 *   5. db.select().from(agentMcpToolPermissions) → mcpPerms
 *
 * Any subsequent calls (e.g. channelLinks if telegram is configured) return [].
 */
function setupDbMock(
  agentsData: ReturnType<typeof makeAgent>[],
  mcpConnections: ReturnType<typeof makeMcpConnection>[],
  mcpPerms: ReturnType<typeof makeMcpPerm>[]
) {
  // call 1: agents
  const agentsFrom = vi.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(agentsData), {
      innerJoin: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([]), {
          where: vi.fn().mockResolvedValue([]),
        })
      ),
      where: vi.fn().mockResolvedValue([]),
    })
  );

  // call 2: agentConnectionPermissions innerJoin integrationConnections where(ne(status,'pending'))
  const permissionsFrom = vi.fn().mockImplementation(() =>
    Object.assign(Promise.resolve([]), {
      innerJoin: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([]), {
          where: vi.fn().mockResolvedValue([]),
        })
      ),
      where: vi.fn().mockResolvedValue([]),
    })
  );

  // call 3: integrationConnections where(type='web-search') → []
  // call 4: integrationConnections where(and(type='mcp',status='active')) → mcpConnections
  // call 5: agentMcpToolPermissions → mcpPerms
  //
  // Calls 3 and 4 both query integrationConnections with .where() — we use
  // mockReturnValueOnce on the `from` mock to differentiate them.
  let integrationConnectionsCallCount = 0;
  const integrationConnectionsFrom = vi.fn().mockImplementation(() => {
    integrationConnectionsCallCount++;
    if (integrationConnectionsCallCount === 1) {
      // call 3: web-search query → []
      return Object.assign(Promise.resolve([]), {
        where: vi.fn().mockResolvedValue([]),
        innerJoin: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve([]), {
            where: vi.fn().mockResolvedValue([]),
          })
        ),
      });
    }
    // call 4: mcp query → mcpConnections
    return Object.assign(Promise.resolve(mcpConnections), {
      where: vi.fn().mockResolvedValue(mcpConnections),
      innerJoin: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([]), {
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    });
  });

  // call 5: agentMcpToolPermissions → mcpPerms (no .where(), returns directly)
  const mcpPermsFrom = vi.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(mcpPerms), {
      where: vi.fn().mockResolvedValue(mcpPerms),
      innerJoin: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([]), {
          where: vi.fn().mockResolvedValue([]),
        })
      ),
    })
  );

  // Sequence: agents, permissions, integrationConnections (×2), mcpPerms
  let selectCallCount = 0;
  mockedDb.select.mockImplementation(() => {
    selectCallCount++;
    const fromFn =
      selectCallCount === 1
        ? agentsFrom
        : selectCallCount === 2
          ? permissionsFrom
          : selectCallCount === 3 || selectCallCount === 4
            ? integrationConnectionsFrom
            : mcpPermsFrom;
    return { from: fromFn } as never;
  });
}

// build.ts emits OpenClaw-NATIVE remote MCP: a top-level `mcp.servers` block
// whose url points at Pinchy's credential-injecting proxy + per-agent
// `tools.allow`. The third-party token is NEVER in the config — the proxy
// injects it at request time. (These scenarios were ported from the former
// pinchy-mcp plugin-emission tests when the plugin was removed.)
describe("MCP config generation (native + proxy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("emits mcp.servers pointing at the Pinchy proxy + per-agent tools.allow, NO pinchy-mcp plugin", async () => {
    const agent = makeAgent({ id: "agent-xyz" });
    const conn = makeMcpConnection({ id: "conn-abc" });
    const perms = [
      makeMcpPerm("agent-xyz", "conn-abc", "create_issue"),
      makeMcpPerm("agent-xyz", "conn-abc", "list_repos"),
    ];

    setupDbMock([agent], [conn], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);

    // Native servers block keyed by the SANITIZED server key (not the raw
    // connectionId), pointed at the PROXY (never the third-party server),
    // transport normalized.
    const serverKey = mcpServerKey("conn-abc");
    const server = config.mcp?.servers?.[serverKey];
    expect(server).toBeDefined();
    expect(config.mcp?.servers?.["conn-abc"]).toBeUndefined(); // raw id is NOT the key
    expect(server.url).toContain("/api/internal/mcp-proxy/conn-abc"); // url carries raw id
    expect(server.url).not.toContain("githubcopilot.com"); // not the upstream
    expect(server.transport).toBe("streamable-http"); // http → streamable-http

    // Header carries ONLY the gateway bootstrap token — not a third-party
    // credential and not a ${VAR} env template.
    expect(server.headers.Authorization).toMatch(/^Bearer .+/);
    expect(server.headers.Authorization).not.toContain("${");
    expect(server.headers.Authorization).not.toContain("ghp_secret_leaked");

    // Per-agent gating via the standard tool policy: the MATERIALIZED tool
    // name (<serverKey>__<tool>) so it matches what OpenClaw exposes.
    const agentEntry = (
      config.agents.list as Array<{ id: string; tools?: { allow?: string[] } }>
    ).find((a) => a.id === "agent-xyz");
    expect(agentEntry?.tools?.allow).toEqual(
      expect.arrayContaining([
        nativeMcpToolName("conn-abc", "create_issue"),
        nativeMcpToolName("conn-abc", "list_repos"),
      ])
    );

    // The custom plugin must NOT be emitted.
    expect(config.plugins?.entries?.["pinchy-mcp"]).toBeUndefined();
  });

  it("emits a distinct server for each connection assigned to the same agent", async () => {
    const agent = makeAgent({ id: "agent-multi" });
    const conn1 = makeMcpConnection({ id: "conn-github-1", preset: "github" });
    const conn2 = makeMcpConnection({
      id: "conn-linear-1",
      preset: "linear",
      url: "https://mcp.linear.app/mcp",
    });
    const perms = [
      makeMcpPerm("agent-multi", "conn-github-1", "create_issue"),
      makeMcpPerm("agent-multi", "conn-linear-1", "search_pages"),
    ];

    setupDbMock([agent], [conn1, conn2], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    const k1 = mcpServerKey("conn-github-1");
    const k2 = mcpServerKey("conn-linear-1");
    expect(k1).not.toBe(k2);
    expect(config.mcp.servers[k1].url).toContain("/api/internal/mcp-proxy/conn-github-1");
    expect(config.mcp.servers[k2].url).toContain("/api/internal/mcp-proxy/conn-linear-1");
    expect(Object.keys(config.mcp.servers)).toHaveLength(2);
  });

  it("omits config.mcp entirely when an agent has no MCP permissions", async () => {
    const agent = makeAgent({ id: "agent-no-mcp" });
    setupDbMock([agent], [], []);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.mcp).toBeUndefined();
    expect(config.plugins?.entries?.["pinchy-mcp"]).toBeUndefined();
  });

  it("omits a connection with no granted tools even when the connection is active", async () => {
    const agent = makeAgent({ id: "agent-xyz" });
    const conn = makeMcpConnection({ id: "conn-abc" });
    const connOrphan = makeMcpConnection({ id: "conn-orphan", name: "Orphan MCP" });
    const perms = [makeMcpPerm("agent-xyz", "conn-abc", "create_issue")];

    setupDbMock([agent], [conn, connOrphan], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(config.mcp.servers[mcpServerKey("conn-abc")]).toBeDefined();
    expect(config.mcp.servers[mcpServerKey("conn-orphan")]).toBeUndefined();
    expect(Object.keys(config.mcp.servers)).toHaveLength(1);
  });

  it("does NOT emit extraHeaders into the config (the proxy injects them from the DB)", async () => {
    const agent = makeAgent({ id: "agent-ghl" });
    const conn = makeMcpConnection({
      id: "conn-ghl-1",
      preset: "highlevel",
      url: "https://services.leadconnectorhq.com/mcp/",
    });
    (conn.data as { extraHeaders?: Record<string, string> }).extraHeaders = {
      locationId: "110411007T",
    };
    const perms = [makeMcpPerm("agent-ghl", "conn-ghl-1", "create_issue")];

    setupDbMock([agent], [conn], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    // locationId stays in Pinchy's DB and is injected by the proxy at request
    // time — it must never appear in openclaw.json.
    expect(written).not.toContain("110411007T");
    expect(written).not.toContain("locationId");
  });

  it("never writes the third-party token into the native config (proxy injects it at request time)", async () => {
    const agent = makeAgent({ id: "agent-secret" });
    const conn = makeMcpConnection({ id: "conn-secret" });
    const perms = [makeMcpPerm("agent-secret", "conn-secret", "create_issue")];

    setupDbMock([agent], [conn], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    // The connection's real token (decrypt is identity in tests) must never
    // reach openclaw.json — build.ts doesn't even decrypt it; the proxy does.
    expect(written).not.toContain("ghp_secret_leaked");
  });
});
