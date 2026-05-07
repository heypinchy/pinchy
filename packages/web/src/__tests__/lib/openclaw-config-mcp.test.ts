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

describe("pinchy-mcp config generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("emits pinchy-mcp plugin with correct connections[] for a single active MCP connection with agent grants", async () => {
    const agent = makeAgent({ id: "agent-xyz" });
    const conn = makeMcpConnection({ id: "conn-abc" });
    const perms = [
      makeMcpPerm("agent-xyz", "conn-abc", "create_issue"),
      makeMcpPerm("agent-xyz", "conn-abc", "list_repos"),
    ];

    setupDbMock([agent], [conn], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const mcpPlugin = config.plugins?.entries?.["pinchy-mcp"];
    expect(mcpPlugin).toBeDefined();
    expect(mcpPlugin.enabled).toBe(true);

    const mcpConfig = mcpPlugin.config;
    expect(mcpConfig.apiBaseUrl).toMatch(/^http/);
    expect(typeof mcpConfig.gatewayToken).toBe("string");
    expect(mcpConfig.gatewayToken.length).toBeGreaterThan(0);

    expect(mcpConfig.connections).toHaveLength(1);
    const [connection] = mcpConfig.connections;
    expect(connection.connectionId).toBe("conn-abc");
    expect(connection.preset).toBe("github");
    expect(connection.transport).toBe("http");
    expect(connection.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(connection.toolPrefix).toBe("github_");
    expect(connection.agentTools).toEqual({
      "agent-xyz": expect.arrayContaining(["create_issue", "list_repos"]),
    });
  });

  it("emits distinct connectionIds for two active MCP connections assigned to the same agent", async () => {
    const agent = makeAgent({ id: "agent-multi" });
    const conn1 = makeMcpConnection({ id: "conn-github-1", preset: "github" });
    const conn2 = makeMcpConnection({
      id: "conn-notion-1",
      preset: "notion",
      url: "https://api.notion.com/mcp/",
      toolPrefix: "notion_",
    });
    const perms = [
      makeMcpPerm("agent-multi", "conn-github-1", "create_issue"),
      makeMcpPerm("agent-multi", "conn-notion-1", "search_pages"),
    ];

    setupDbMock([agent], [conn1, conn2], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const mcpConfig = config.plugins?.entries?.["pinchy-mcp"]?.config;
    expect(mcpConfig).toBeDefined();
    expect(mcpConfig.connections).toHaveLength(2);

    const connectionIds = mcpConfig.connections.map(
      (c: { connectionId: string }) => c.connectionId
    );
    expect(new Set(connectionIds).size).toBe(2);
    expect(connectionIds).toContain("conn-github-1");
    expect(connectionIds).toContain("conn-notion-1");
  });

  it("omits pinchy-mcp entirely when an agent exists but has no MCP permissions", async () => {
    const agent = makeAgent({ id: "agent-no-mcp" });
    // No perms, no connections
    setupDbMock([agent], [], []);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins?.entries?.["pinchy-mcp"]).toBeUndefined();
  });

  it("omits a connection with no granted tools even when the connection is active", async () => {
    const agent = makeAgent({ id: "agent-xyz" });
    const conn = makeMcpConnection({ id: "conn-abc" });
    // perms only for conn-abc, not for conn-orphan
    const connOrphan = makeMcpConnection({ id: "conn-orphan", name: "Orphan MCP" });
    const perms = [makeMcpPerm("agent-xyz", "conn-abc", "create_issue")];

    setupDbMock([agent], [conn, connOrphan], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const mcpConfig = config.plugins?.entries?.["pinchy-mcp"]?.config;
    expect(mcpConfig).toBeDefined();
    expect(mcpConfig.connections).toHaveLength(1);
    expect(mcpConfig.connections[0].connectionId).toBe("conn-abc");
  });

  it("emits both pinchy-odoo and pinchy-mcp for an agent with mixed permissions", async () => {
    const agent = makeAgent({ id: "agent-mixed" });
    const mcpConn = makeMcpConnection({ id: "conn-mcp-1" });
    const perms = [makeMcpPerm("agent-mixed", "conn-mcp-1", "list_repos")];

    // Odoo permissions come from agentConnectionPermissions (call 2)
    const odooPermissions = [
      {
        agent_connection_permissions: {
          agentId: "agent-mixed",
          connectionId: "conn-odoo-1",
          model: "sale.order",
          operation: "read",
        },
        integration_connections: {
          id: "conn-odoo-1",
          type: "odoo",
          name: "Test Odoo",
          description: "",
          credentials: JSON.stringify({
            url: "https://odoo.test",
            db: "test",
            uid: 2,
            apiKey: "k",
          }),
          data: null,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

    // Custom setup for mixed scenario
    let selectCallCount = 0;
    mockedDb.select.mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // agents
        return {
          from: vi.fn().mockImplementation(() =>
            Object.assign(Promise.resolve([agent]), {
              innerJoin: vi.fn().mockReturnValue(
                Object.assign(Promise.resolve([]), {
                  where: vi.fn().mockResolvedValue([]),
                })
              ),
              where: vi.fn().mockResolvedValue([]),
            })
          ),
        } as never;
      }
      if (selectCallCount === 2) {
        // agentConnectionPermissions innerJoin integrationConnections
        return {
          from: vi.fn().mockImplementation(() =>
            Object.assign(Promise.resolve([]), {
              innerJoin: vi.fn().mockReturnValue(
                Object.assign(Promise.resolve([]), {
                  where: vi.fn().mockResolvedValue(odooPermissions),
                })
              ),
              where: vi.fn().mockResolvedValue([]),
            })
          ),
        } as never;
      }
      if (selectCallCount === 3) {
        // integrationConnections where type='web-search' → []
        return {
          from: vi.fn().mockImplementation(() =>
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
              innerJoin: vi.fn().mockReturnValue(
                Object.assign(Promise.resolve([]), {
                  where: vi.fn().mockResolvedValue([]),
                })
              ),
            })
          ),
        } as never;
      }
      if (selectCallCount === 4) {
        // integrationConnections where type='mcp' and status='active' → mcpConn
        return {
          from: vi.fn().mockImplementation(() =>
            Object.assign(Promise.resolve([mcpConn]), {
              where: vi.fn().mockResolvedValue([mcpConn]),
              innerJoin: vi.fn().mockReturnValue(
                Object.assign(Promise.resolve([]), {
                  where: vi.fn().mockResolvedValue([]),
                })
              ),
            })
          ),
        } as never;
      }
      // call 5: agentMcpToolPermissions → perms
      return {
        from: vi.fn().mockImplementation(() =>
          Object.assign(Promise.resolve(perms), {
            where: vi.fn().mockResolvedValue(perms),
            innerJoin: vi.fn().mockReturnValue(
              Object.assign(Promise.resolve([]), {
                where: vi.fn().mockResolvedValue([]),
              })
            ),
          })
        ),
      } as never;
    });

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins?.entries?.["pinchy-odoo"]).toBeDefined();
    expect(config.plugins?.entries?.["pinchy-mcp"]).toBeDefined();
  });

  it("does not include credentials field in the emitted pinchy-mcp config", async () => {
    const agent = makeAgent({ id: "agent-cred-check" });
    const conn = makeMcpConnection({
      id: "conn-secret",
      tools: [{ name: "some_tool", description: "x", inputSchema: { type: "object" } }],
      // The connection has a real token in `credentials` field (encrypted in DB, decrypted here)
    });
    const perms = [makeMcpPerm("agent-cred-check", "conn-secret", "some_tool")];

    setupDbMock([agent], [conn], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;

    // The raw credential value from the connection must never appear in config
    expect(written).not.toContain("ghp_secret_leaked");

    const config = JSON.parse(written);
    const mcpConfig = config.plugins?.entries?.["pinchy-mcp"]?.config;
    expect(mcpConfig).toBeDefined();

    // No top-level credentials field
    expect(mcpConfig.credentials).toBeUndefined();

    // No credentials field on any connection entry
    for (const conn of mcpConfig.connections) {
      expect((conn as Record<string, unknown>).credentials).toBeUndefined();
      expect((conn as Record<string, unknown>).token).toBeUndefined();
      expect((conn as Record<string, unknown>).apiKey).toBeUndefined();
    }
  });
});
