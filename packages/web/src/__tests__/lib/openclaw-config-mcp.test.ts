import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  getSettingsByPrefix: vi.fn().mockResolvedValue(new Map()),
  setSetting: vi.fn().mockResolvedValue(undefined),
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
import { computeAllowedTools } from "@/lib/tool-registry";
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

function getWrittenConfigString(): string {
  const call = mockedWriteFileSync.mock.calls.find(
    (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
  );
  if (!call) throw new Error("openclaw.json was never written");
  return call[1] as string;
}

const DEFAULT_TEST_TOOLS = [
  { name: "create_issue", description: "Create issue", inputSchema: { type: "object" } },
  { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
  { name: "search_pages", description: "Search pages", inputSchema: { type: "object" } },
];

function makeMcpConnection(
  overrides: Partial<{
    id: string;
    name: string;
    preset: string;
    transport: "http" | "sse";
    url: string;
    status: string;
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    extraHeaders: Record<string, string>;
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
    extraHeaders,
  } = overrides;
  return {
    id,
    name,
    type: "mcp" as const,
    description: "",
    // credentials is AES-256-GCM encrypted JSON — never put in plugin config
    credentials: JSON.stringify({ token: "ghp_secret_leaked" }),
    data: {
      type: "mcp",
      preset,
      transport,
      url,
      tools,
      lastSyncAt: new Date().toISOString(),
      ...(extraHeaders ? { extraHeaders } : {}),
    },
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeAgent(
  overrides: Partial<{
    id: string;
    name: string;
    model: string;
    allowedTools: string[];
  }> = {}
) {
  return {
    id: overrides.id ?? "agent-1",
    name: overrides.name ?? "Test Agent",
    model: overrides.model ?? "anthropic/claude-haiku-4-5-20251001",
    allowedTools: overrides.allowedTools ?? [],
    pluginConfig: null,
    isPersonal: false,
    ownerId: null,
    deletedAt: null,
    skills: [],
    createdAt: new Date(),
  };
}

// Row shape returned by db.select().from(agentConnectionPermissions)
// .innerJoin(integrationConnections).where(...) — the SAME shared query
// build.ts uses for email/odoo (`allPermissions`). MCP grants are ordinary
// rows with model:"mcp" (D1) — reused here instead of a second query.
function makeMcpPermRow(
  agentId: string,
  toolName: string,
  connection: ReturnType<typeof makeMcpConnection>
) {
  return {
    agent_connection_permissions: {
      agentId,
      connectionId: connection.id,
      model: "mcp",
      operation: toolName,
    },
    integration_connections: connection,
  };
}

function mockDb(
  agentsData: ReturnType<typeof makeAgent>[],
  permissionsData: ReturnType<typeof makeMcpPermRow>[]
) {
  mockedDb.select.mockReturnValue({
    from: vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve(agentsData), {
        innerJoin: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve(permissionsData), {
            where: vi.fn().mockResolvedValue(permissionsData),
          })
        ),
        where: vi.fn().mockResolvedValue([]),
      })
    ),
  } as never);
}

// build.ts emits OpenClaw-NATIVE remote MCP: a top-level `mcp.servers` block
// whose url points at Pinchy's credential-injecting proxy + per-agent
// `tools.allow`, gated by PINCHY_MCP_ENABLED and drift-filtered against each
// connection's currently-synced data.tools.
describe("MCP config generation (native + proxy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits mcp.servers pointing at the Pinchy proxy + per-agent tools.allow", async () => {
    const agent = makeAgent({ id: "agent-xyz" });
    const conn = makeMcpConnection({ id: "conn-abc" });
    const perms = [
      makeMcpPermRow("agent-xyz", "create_issue", conn),
      makeMcpPermRow("agent-xyz", "list_repos", conn),
    ];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());

    const serverKey = mcpServerKey("conn-abc");
    const server = config.mcp?.servers?.[serverKey];
    expect(server).toBeDefined();
    expect(config.mcp?.servers?.["conn-abc"]).toBeUndefined(); // raw id is NOT the key
    expect(server.url).toBe("http://pinchy:7777/api/internal/mcp-proxy/conn-abc");
    expect(server.url).not.toContain("githubcopilot.com"); // not the upstream
    expect(server.transport).toBe("streamable-http"); // http → streamable-http

    expect(server.headers.Authorization).toMatch(/^Bearer .+/);
    expect(server.headers.Authorization).not.toContain("${");
    expect(server.headers.Authorization).not.toContain("ghp_secret_leaked");
    expect(Object.keys(server.headers)).toEqual(["Authorization"]);

    const agentEntry = (
      config.agents.list as Array<{ id: string; tools?: { allow?: string[] } }>
    ).find((a) => a.id === "agent-xyz")!;
    expect(agentEntry.tools?.allow).toEqual(
      expect.arrayContaining([
        nativeMcpToolName("conn-abc", "create_issue"),
        nativeMcpToolName("conn-abc", "list_repos"),
      ])
    );
  });

  it("appends MCP tool names AFTER computeAllowedTools()'s fail-closed base, never replacing it", async () => {
    const agent = makeAgent({ id: "agent-xyz" });
    const conn = makeMcpConnection({ id: "conn-abc" });
    const perms = [makeMcpPermRow("agent-xyz", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    const agentEntry = (
      config.agents.list as Array<{ id: string; tools?: { allow?: string[]; fs?: unknown } }>
    ).find((a) => a.id === "agent-xyz")!;

    const base = computeAllowedTools();
    const allow = agentEntry.tools!.allow!;
    // Base entries are all present, in their original relative order, with
    // the MCP name(s) appended after — not substituted or reordered.
    expect(allow.slice(0, base.length)).toEqual(base);
    expect(allow.slice(base.length)).toEqual([nativeMcpToolName("conn-abc", "create_issue")]);
    // fs.workspaceOnly (a sibling of `allow`) must survive the append.
    expect(agentEntry.tools?.fs).toEqual({ workspaceOnly: true });
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
      makeMcpPermRow("agent-multi", "create_issue", conn1),
      makeMcpPermRow("agent-multi", "search_pages", conn2),
    ];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    const k1 = mcpServerKey("conn-github-1");
    const k2 = mcpServerKey("conn-linear-1");
    expect(k1).not.toBe(k2);
    expect(config.mcp.servers[k1].url).toBe(
      "http://pinchy:7777/api/internal/mcp-proxy/conn-github-1"
    );
    expect(config.mcp.servers[k2].url).toBe(
      "http://pinchy:7777/api/internal/mcp-proxy/conn-linear-1"
    );
    expect(Object.keys(config.mcp.servers)).toHaveLength(2);
  });

  it("omits config.mcp entirely when no agent has any MCP permission", async () => {
    const agent = makeAgent({ id: "agent-no-mcp" });
    mockDb([agent], []);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    expect(config.mcp).toBeUndefined();
  });

  it("DRIFT FILTER: omits a granted tool that a re-sync removed from data.tools, and drops the connection entirely once no grant survives", async () => {
    const agent = makeAgent({ id: "agent-drift" });
    // Connection currently only exposes list_repos — create_issue was granted
    // earlier but a re-sync (POST .../sync) has since removed it upstream.
    const conn = makeMcpConnection({
      id: "conn-drift",
      tools: [{ name: "list_repos", description: "List repos", inputSchema: {} }],
    });
    const perms = [
      makeMcpPermRow("agent-drift", "create_issue", conn), // stale grant, must be filtered
      makeMcpPermRow("agent-drift", "list_repos", conn), // still valid
    ];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    const agentEntry = (
      config.agents.list as Array<{ id: string; tools?: { allow?: string[] } }>
    ).find((a) => a.id === "agent-drift")!;

    expect(agentEntry.tools?.allow).toContain(nativeMcpToolName("conn-drift", "list_repos"));
    expect(agentEntry.tools?.allow).not.toContain(nativeMcpToolName("conn-drift", "create_issue"));
  });

  it("DRIFT FILTER: omits the connection from mcp.servers when EVERY granted tool has drifted out", async () => {
    const agent = makeAgent({ id: "agent-all-drifted" });
    const conn = makeMcpConnection({
      id: "conn-all-drifted",
      tools: [{ name: "some_other_tool", description: "", inputSchema: {} }],
    });
    const perms = [makeMcpPermRow("agent-all-drifted", "create_issue", conn)]; // no longer synced

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    expect(config.mcp).toBeUndefined();
  });

  it("excludes an auth_failed MCP connection from mcp.servers even though grants exist", async () => {
    const agent = makeAgent({ id: "agent-broken" });
    const conn = makeMcpConnection({ id: "conn-broken", status: "auth_failed" });
    const perms = [makeMcpPermRow("agent-broken", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    expect(config.mcp).toBeUndefined();
    const agentEntry = (
      config.agents.list as Array<{ id: string; tools?: { allow?: string[] } }>
    ).find((a) => a.id === "agent-broken")!;
    expect(agentEntry.tools?.allow).not.toContain(nativeMcpToolName("conn-broken", "create_issue"));
  });

  it("does NOT emit extraHeaders into the config (the proxy injects them from the DB)", async () => {
    const agent = makeAgent({ id: "agent-ghl" });
    const conn = makeMcpConnection({
      id: "conn-ghl-1",
      preset: "highlevel",
      url: "https://services.leadconnectorhq.com/mcp/",
      extraHeaders: { locationId: "110411007T" },
    });
    const perms = [makeMcpPermRow("agent-ghl", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = getWrittenConfigString();
    // locationId stays in Pinchy's DB and is injected by the proxy at request
    // time — it must never appear in openclaw.json.
    expect(written).not.toContain("110411007T");
    expect(written).not.toContain("locationId");
  });

  it("never writes the third-party token/credentials into the native config (proxy injects it at request time)", async () => {
    const agent = makeAgent({ id: "agent-secret" });
    const conn = makeMcpConnection({ id: "conn-secret" });
    const perms = [makeMcpPermRow("agent-secret", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = getWrittenConfigString();
    expect(written).not.toContain("ghp_secret_leaked");
  });

  it("FLAG OFF: omits config.mcp and every MCP tool name from tools.allow even though active grants exist", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const agent = makeAgent({ id: "agent-flagged" });
    const conn = makeMcpConnection({ id: "conn-flagged" });
    const perms = [makeMcpPermRow("agent-flagged", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    expect(config.mcp).toBeUndefined();

    const agentEntry = (
      config.agents.list as Array<{ id: string; tools?: { allow?: string[] } }>
    ).find((a) => a.id === "agent-flagged")!;
    expect(agentEntry.tools?.allow).not.toContain(
      nativeMcpToolName("conn-flagged", "create_issue")
    );
    expect(agentEntry.tools?.allow).toEqual(computeAllowedTools());
  });
});
