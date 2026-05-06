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

const { mockDecrypt } = vi.hoisted(() => ({
  mockDecrypt: vi.fn((val: string) => val),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: (val: string) => mockDecrypt(val),
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

function makeWebSearchConnection(
  overrides: Partial<{ apiKey: string; id: string; name: string }> = {}
) {
  const { apiKey = "brave-api-key-abc", id = "conn-brave-1", name = "Brave Search" } = overrides;
  return {
    id,
    name,
    type: "web-search",
    description: "",
    credentials: JSON.stringify({ apiKey }),
    data: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("pinchy-web config generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
    mockDecrypt.mockImplementation((val: string) => val);
  });

  it("includes pinchy-web plugin when a web-search connection exists and agent has pinchy_web_search", async () => {
    const agentsData = [
      {
        id: "ws-agent",
        name: "Web Search Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection();

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins?.entries?.["pinchy-web"]).toBeDefined();
    expect(config.plugins.entries["pinchy-web"].enabled).toBe(true);
  });

  it("puts braveApiKey and agent tools into the plugin config", async () => {
    const agentsData = [
      {
        id: "ws-agent",
        name: "Web Search Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search", "pinchy_web_fetch"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection({ apiKey: "brave-key-xyz" });

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const webPluginConfig = config.plugins.entries["pinchy-web"].config;
    // The braveApiKey is fetched on demand via Pinchy's credentials API —
    // openclaw.json carries only the connectionId + bootstrap creds for
    // the API call (#209).
    expect(webPluginConfig.braveApiKey).toBeUndefined();
    expect(typeof webPluginConfig.connectionId).toBe("string");
    expect(typeof webPluginConfig.apiBaseUrl).toBe("string");
    expect(typeof webPluginConfig.gatewayToken).toBe("string");

    const agentConfig = webPluginConfig.agents["ws-agent"];
    expect(agentConfig.tools).toEqual(["pinchy_web_search", "pinchy_web_fetch"]);
  });

  it("includes only pinchy_web_search when agent has only that tool", async () => {
    const agentsData = [
      {
        id: "search-only-agent",
        name: "Search Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection();

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const agentConfig = config.plugins.entries["pinchy-web"].config.agents["search-only-agent"];
    expect(agentConfig.tools).toEqual(["pinchy_web_search"]);
  });

  it("includes only pinchy_web_fetch when agent has only that tool", async () => {
    const agentsData = [
      {
        id: "fetch-only-agent",
        name: "Fetch Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_fetch"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection();

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const agentConfig = config.plugins.entries["pinchy-web"].config.agents["fetch-only-agent"];
    expect(agentConfig.tools).toEqual(["pinchy_web_fetch"]);
  });

  it("excludes agents without web tools from pinchy-web agent configs", async () => {
    const agentsData = [
      {
        id: "web-agent",
        name: "Web Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: {},
        createdAt: new Date(),
      },
      {
        id: "plain-agent",
        name: "Plain Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_ls", "pinchy_read"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection();

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const agents = config.plugins.entries["pinchy-web"].config.agents;
    expect(Object.keys(agents)).toEqual(["web-agent"]);
    expect(agents["plain-agent"]).toBeUndefined();
  });

  it("skips pinchy-web plugin when no web-search connection exists", async () => {
    const agentsData = [
      {
        id: "ws-agent",
        name: "Web Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([]), // no web-search connection
        })
      ),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins?.entries?.["pinchy-web"]).toBeUndefined();
  });

  it("does not decrypt web-search credentials at config-write time (#209)", async () => {
    // Since #209: pinchy-web fetches braveApiKey lazily via the
    // /api/internal/integrations/:id/credentials endpoint. Decryption
    // happens at fetch time, not at config-write time. So a broken
    // ENCRYPTION_KEY no longer prevents the plugin from being registered
    // — the agent just sees a clear error on the first tool call.
    const agentsData = [
      {
        id: "ws-agent",
        name: "Web Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection();

    // decrypt should NOT be called for web-search anymore. Make it throw
    // to prove the new code path doesn't invoke it.
    mockDecrypt.mockImplementation(() => {
      throw new Error("decrypt should not be called for pinchy-web (#209)");
    });

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // Plugin IS registered with the connectionId — the failure surface
    // moved from config-write time to credentials-fetch time.
    expect(config.plugins?.entries?.["pinchy-web"]).toBeDefined();
    expect(config.plugins?.entries?.["pinchy-web"]?.config?.connectionId).toBe(webConn.id);
  });

  it("skips pinchy-web plugin when no agents have web tools (even if connection exists)", async () => {
    const agentsData = [
      {
        id: "plain-agent",
        name: "Plain Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_ls"],
        pluginConfig: {},
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection();

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins?.entries?.["pinchy-web"]).toBeUndefined();
  });

  it("spreads pluginConfig['pinchy-web'] into agent config", async () => {
    const agentsData = [
      {
        id: "ws-agent",
        name: "Web Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_web_search"],
        pluginConfig: { "pinchy-web": { allowedDomains: ["example.com", "docs.example.com"] } },
        createdAt: new Date(),
      },
    ];
    const webConn = makeWebSearchConnection();

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve([]), {
              where: vi.fn().mockResolvedValue([]),
            })
          ),
          where: vi.fn().mockResolvedValue([webConn]),
        })
      ),
    } as never);

    mockedReadFileSync.mockReturnValue(JSON.stringify(gatewayConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const agentConfig = config.plugins.entries["pinchy-web"].config.agents["ws-agent"];
    expect(agentConfig.tools).toEqual(["pinchy_web_search"]);
    expect(agentConfig.allowedDomains).toEqual(["example.com", "docs.example.com"]);
  });
});
