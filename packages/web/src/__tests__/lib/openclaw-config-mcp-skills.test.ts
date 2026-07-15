import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  const renameSyncMock = vi.fn();
  const chmodSyncMock = vi.fn();
  const rmSyncMock = vi.fn();
  const readdirSyncMock = vi.fn().mockImplementation(() => {
    const err = new Error("ENOENT: no such file or directory");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  });
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
      rmSync: rmSyncMock,
      readdirSync: readdirSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
    chmodSync: chmodSyncMock,
    rmSync: rmSyncMock,
    readdirSync: readdirSyncMock,
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

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn(async () => ""),
}));

import { writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { mcpSkillId } from "@/lib/skills/mcp-skill";
import { nativeMcpToolName } from "@/lib/openclaw-config/native-mcp";
import { db } from "@/db";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedDb = vi.mocked(db);

const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

function getWrittenConfigString(): string {
  const call = mockedWriteFileSync.mock.calls.find(
    (c) => typeof c[0] === "string" && (c[0] as string).endsWith(".json.tmp")
  );
  if (!call) throw new Error("openclaw.json was never written");
  return call[1] as string;
}

function findSkillWrite(agentId: string, skillId: string) {
  return mockedWriteFileSync.mock.calls.find(
    (c) =>
      typeof c[0] === "string" &&
      (c[0] as string).includes(`/workspaces/${agentId}/skills/${skillId}/SKILL.md`)
  );
}

const DEFAULT_TEST_TOOLS = [
  { name: "create_issue", description: "Create issue", inputSchema: { type: "object" } },
  { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
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
    credentials: JSON.stringify({ token: "ghp_secret" }),
    data: {
      type: "mcp",
      preset,
      transport,
      url,
      tools,
      lastSyncAt: new Date().toISOString(),
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
    skills: string[] | null;
    deletedAt: Date | null;
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
    deletedAt: overrides.deletedAt ?? null,
    skills: overrides.skills === undefined ? [] : overrides.skills,
    createdAt: new Date(),
  };
}

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

describe("regenerateOpenClawConfig — dynamic MCP skills (D2, T7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_MCP_ENABLED", "1");
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedReaddirSync.mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes a SKILL.md for a (agent, connection) pair with a surviving grant and appends its id to agents.list[].skills", async () => {
    const agent = makeAgent({ id: "agent-xyz" });
    const conn = makeMcpConnection({ id: "conn-abc" });
    const perms = [
      makeMcpPermRow("agent-xyz", "create_issue", conn),
      makeMcpPermRow("agent-xyz", "list_repos", conn),
    ];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const skillId = mcpSkillId("conn-abc");
    const skillWrite = findSkillWrite("agent-xyz", skillId);
    expect(skillWrite).toBeDefined();
    const body = skillWrite![1] as string;
    expect(body).toContain(`name: ${skillId}`);
    expect(body).toContain(nativeMcpToolName("conn-abc", "create_issue"));
    expect(body).toContain(nativeMcpToolName("conn-abc", "list_repos"));

    const config = JSON.parse(getWrittenConfigString());
    const agentEntry = config.agents.list.find((a: { id: string }) => a.id === "agent-xyz");
    expect(agentEntry.skills).toContain(skillId);
  });

  it("appends the dynamic skill id AFTER the KNOWN_SKILLS-validated DB skills, without disturbing them", async () => {
    const agent = makeAgent({ id: "agent-both", skills: ["web-search"] });
    const conn = makeMcpConnection({ id: "conn-both" });
    const perms = [makeMcpPermRow("agent-both", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockImplementation((path: unknown) => {
      if (typeof path === "string" && path.endsWith(".json")) {
        return JSON.stringify(gatewayConfig);
      }
      if (typeof path === "string" && path.endsWith("/SKILL.md") && path.includes("web-search")) {
        return "---\nname: web-search\ndescription: Test skill body.\n---\n\n# Body\n";
      }
      throw new Error("ENOENT");
    });

    await regenerateOpenClawConfig();

    const config = JSON.parse(getWrittenConfigString());
    const agentEntry = config.agents.list.find((a: { id: string }) => a.id === "agent-both");
    expect(agentEntry.skills).toEqual(["web-search", mcpSkillId("conn-both")]);
  });

  it("DB skill validation stays strict: an unknown DB skill id still throws even when the agent also has MCP grants", async () => {
    const agent = makeAgent({ id: "agent-broken", skills: ["nonexistent-skill"] });
    const conn = makeMcpConnection({ id: "conn-broken-db" });
    const perms = [makeMcpPermRow("agent-broken", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await expect(regenerateOpenClawConfig()).rejects.toThrow(/unknown skill/i);
  });

  it("FLAG OFF: writes no dynamic skill file and does not add any mcp- id to agents.list[].skills", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const agent = makeAgent({ id: "agent-flagged" });
    const conn = makeMcpConnection({ id: "conn-flagged" });
    const perms = [makeMcpPermRow("agent-flagged", "create_issue", conn)];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const skillId = mcpSkillId("conn-flagged");
    expect(findSkillWrite("agent-flagged", skillId)).toBeUndefined();

    const config = JSON.parse(getWrittenConfigString());
    const agentEntry = config.agents.list.find((a: { id: string }) => a.id === "agent-flagged");
    expect(agentEntry.skills).toEqual([]);
  });

  it("DRIFT: a tool removed by a re-sync no longer appears in the skill body, even though other granted tools do", async () => {
    const agent = makeAgent({ id: "agent-drift" });
    const conn = makeMcpConnection({
      id: "conn-drift",
      // create_issue was granted earlier but a re-sync has since removed it.
      tools: [{ name: "list_repos", description: "List repos", inputSchema: {} }],
    });
    const perms = [
      makeMcpPermRow("agent-drift", "create_issue", conn), // stale grant
      makeMcpPermRow("agent-drift", "list_repos", conn), // still valid
    ];

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const skillId = mcpSkillId("conn-drift");
    const skillWrite = findSkillWrite("agent-drift", skillId);
    expect(skillWrite).toBeDefined();
    const body = skillWrite![1] as string;
    expect(body).toContain(nativeMcpToolName("conn-drift", "list_repos"));
    expect(body).not.toContain(nativeMcpToolName("conn-drift", "create_issue"));
  });

  it("CLEANUP: a connection deleted between regenerates removes its stale skill directory and drops the id from skills", async () => {
    const agent = makeAgent({ id: "agent-deleted-conn" });

    // Simulate a stale on-disk skill directory left over from an earlier
    // regenerate whose connection no longer exists.
    const staleSkillId = mcpSkillId("conn-now-gone");
    mockedReaddirSync.mockImplementation((dir: unknown) => {
      if (typeof dir === "string" && dir.endsWith("/workspaces/agent-deleted-conn/skills")) {
        return [
          { name: staleSkillId, isDirectory: () => true },
          { name: "web-search", isDirectory: () => true },
        ] as unknown as ReturnType<typeof readdirSync>;
      }
      const err = new Error("ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    // No MCP permissions at all — the connection is gone.
    mockDb([agent], []);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    expect(mockedRmSync).toHaveBeenCalledWith(
      expect.stringContaining(`/workspaces/agent-deleted-conn/skills/${staleSkillId}`),
      { recursive: true, force: true }
    );
    // web-search must never be touched — cleanup is scoped to the mcp- namespace.
    expect(mockedRmSync).not.toHaveBeenCalledWith(
      expect.stringContaining("/workspaces/agent-deleted-conn/skills/web-search"),
      expect.anything()
    );

    const config = JSON.parse(getWrittenConfigString());
    const agentEntry = config.agents.list.find(
      (a: { id: string }) => a.id === "agent-deleted-conn"
    );
    expect(agentEntry.skills).not.toContain(staleSkillId);
  });

  it("CLEANUP: a stale skill survives on disk if the connection is still active and still grants it (no false-positive removal)", async () => {
    const agent = makeAgent({ id: "agent-still-active" });
    const conn = makeMcpConnection({ id: "conn-still-active" });
    const perms = [makeMcpPermRow("agent-still-active", "create_issue", conn)];
    const currentSkillId = mcpSkillId("conn-still-active");

    mockedReaddirSync.mockImplementation((dir: unknown) => {
      if (typeof dir === "string" && dir.endsWith("/workspaces/agent-still-active/skills")) {
        return [{ name: currentSkillId, isDirectory: () => true }] as unknown as ReturnType<
          typeof readdirSync
        >;
      }
      const err = new Error("ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    mockDb([agent], perms);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    expect(mockedRmSync).not.toHaveBeenCalledWith(
      expect.stringContaining(`/workspaces/agent-still-active/skills/${currentSkillId}`),
      expect.anything()
    );
  });

  it("CLEANUP: toggling the feature flag off also removes previously-materialized mcp- skill directories", async () => {
    vi.stubEnv("PINCHY_MCP_ENABLED", "0");

    const agent = makeAgent({ id: "agent-flag-toggled" });
    const staleSkillId = mcpSkillId("conn-from-when-it-was-on");
    mockedReaddirSync.mockImplementation((dir: unknown) => {
      if (typeof dir === "string" && dir.endsWith("/workspaces/agent-flag-toggled/skills")) {
        return [{ name: staleSkillId, isDirectory: () => true }] as unknown as ReturnType<
          typeof readdirSync
        >;
      }
      const err = new Error("ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });

    mockDb([agent], []);
    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    expect(mockedRmSync).toHaveBeenCalledWith(
      expect.stringContaining(`/workspaces/agent-flag-toggled/skills/${staleSkillId}`),
      { recursive: true, force: true }
    );
  });
});
