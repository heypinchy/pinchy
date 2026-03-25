import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
  };
});

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    }),
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/migrate-onboarding", () => ({
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
}));

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { writeOpenClawConfig, regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import { getSetting } from "@/lib/settings";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

describe("writeOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
  });

  it("should write config with Anthropic provider", () => {
    writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-secret",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("openclaw.json"),
      expect.stringContaining('"ANTHROPIC_API_KEY": "sk-ant-secret"'),
      { encoding: "utf-8", mode: 0o644 }
    );
  });

  it("should write config with correct model", () => {
    writeOpenClawConfig({
      provider: "openai",
      apiKey: "sk-key",
      model: "openai/gpt-4o-mini",
    });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.defaults.model.primary).toBe("openai/gpt-4o-mini");
    expect(config.env.OPENAI_API_KEY).toBe("sk-key");
  });

  it("should include gateway mode local and bind lan", () => {
    writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
  });

  it("should create directory if it does not exist", () => {
    mockedExistsSync.mockReturnValue(false);

    writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(mockedMkdirSync).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
    });
  });

  it("should write config with Google provider", () => {
    writeOpenClawConfig({
      provider: "google",
      apiKey: "AIza-key",
      model: "google/gemini-2.5-flash",
    });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.env.GEMINI_API_KEY).toBe("AIza-key");
    expect(config.agents.defaults.model.primary).toBe("google/gemini-2.5-flash");
  });

  it("should generate auth token when no existing config", () => {
    writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.gateway.auth).toBeDefined();
    expect(config.gateway.auth.mode).toBe("token");
    expect(config.gateway.auth.token).toBeTruthy();
    expect(config.gateway.auth.token).toHaveLength(48); // 24 bytes hex
  });

  it("should merge with existing config preserving gateway.auth", () => {
    const existingConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: {
          token: "existing-secret-token",
        },
      },
      meta: {
        version: "1.2.3",
        generatedAt: "2025-01-01T00:00:00Z",
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-20250514" },
        },
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    writeOpenClawConfig({
      provider: "openai",
      apiKey: "sk-new-key",
      model: "openai/gpt-4o",
    });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // Pinchy's fields are applied
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
    expect(config.env.OPENAI_API_KEY).toBe("sk-new-key");
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-4o");

    // OpenClaw's auto-generated fields are preserved
    expect(config.gateway.auth.token).toBe("existing-secret-token");
    expect(config.meta.version).toBe("1.2.3");
    expect(config.meta.generatedAt).toBe("2025-01-01T00:00:00Z");
  });

  it("should write config with restrictive file permissions", () => {
    writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-secret",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(mockedWriteFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      encoding: "utf-8",
      mode: 0o644,
    });
  });

  it("should create config from scratch when no existing file", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-fresh",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-fresh");
    expect(config.agents.defaults.model.primary).toBe("anthropic/claude-haiku-4-5-20251001");
  });
});

const mockedDb = vi.mocked(db);
const mockedGetSetting = vi.mocked(getSetting);

describe("regenerateOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("should write config with restrictive file permissions", async () => {
    await regenerateOpenClawConfig();

    expect(mockedWriteFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      encoding: "utf-8",
      mode: 0o644,
    });
  });

  it("should write agents.list with all agents from DB", async () => {
    const agentsData = [
      {
        id: "uuid-agent-1",
        name: "Smithers",
        model: "anthropic/claude-opus-4-6",
        createdAt: new Date(),
      },
      {
        id: "uuid-agent-2",
        name: "Jeeves",
        model: "openai/gpt-4o",
        createdAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue(agentsData),
    } as never);

    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[0]).toEqual({
      id: "uuid-agent-1",
      name: "Smithers",
      model: "anthropic/claude-opus-4-6",
      workspace: "/root/.openclaw/workspaces/uuid-agent-1",
      tools: { deny: ["group:runtime", "group:fs", "group:web", "pdf", "image", "image_generate"] },
    });
    expect(config.agents.list[1]).toEqual({
      id: "uuid-agent-2",
      name: "Jeeves",
      model: "openai/gpt-4o",
      workspace: "/root/.openclaw/workspaces/uuid-agent-2",
      tools: { deny: ["group:runtime", "group:fs", "group:web", "pdf", "image", "image_generate"] },
    });
  });

  it("should preserve existing gateway.auth fields", async () => {
    const existingConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: {
          token: "existing-secret-token",
        },
      },
      meta: {
        version: "1.2.3",
        generatedAt: "2025-01-01T00:00:00Z",
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.gateway.auth.token).toBe("existing-secret-token");
    // Only gateway block is preserved — other top-level fields (meta, etc.) are rebuilt from DB
    expect(config.meta).toBeUndefined();
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
  });

  it("should include provider env vars from settings", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-decrypted";
      if (key === "openai_api_key") return "sk-openai-decrypted";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-decrypted");
    expect(config.env.OPENAI_API_KEY).toBe("sk-openai-decrypted");
    expect(config.env.GEMINI_API_KEY).toBeUndefined();
  });

  it("should set defaults.model from default provider", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "default_provider") return "openai";
      if (key === "openai_api_key") return "sk-openai-key";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.defaults.model.primary).toBe("openai/gpt-4o-mini");
  });

  it("should handle empty agents list", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.agents.list).toEqual([]);
  });

  it("should handle no configured providers", async () => {
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.env).toEqual({});
    expect(config.agents.defaults).toEqual({});
  });

  it("should deny all groups for agents with only safe tools", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: { allowed_paths: ["/data/hr-docs/", "/data/policies/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const kbAgent = config.agents.list.find((a: { id: string }) => a.id === "kb-agent-id");

    expect(kbAgent.tools).toBeDefined();
    expect(kbAgent.tools.deny).toContain("group:runtime");
    expect(kbAgent.tools.deny).toContain("group:fs");
    expect(kbAgent.tools.deny).toContain("group:web");
    expect(kbAgent.tools.allow).toBeUndefined();
  });

  it("should deny all groups for agents with empty allowedTools", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "custom-agent-id",
          name: "Dev Assistant",
          model: "anthropic/claude-opus-4-6",
          templateId: "custom",
          pluginConfig: null,
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const customAgent = config.agents.list.find((a: { id: string }) => a.id === "custom-agent-id");

    expect(customAgent.tools).toBeDefined();
    expect(customAgent.tools.deny).toContain("group:runtime");
    expect(customAgent.tools.deny).toContain("group:fs");
    expect(customAgent.tools.deny).toContain("group:web");
  });

  it("should not deny group:runtime when shell is allowed", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "power-agent-id",
          name: "Power Agent",
          model: "anthropic/claude-opus-4-6",
          templateId: "custom",
          pluginConfig: null,
          allowedTools: ["shell", "pinchy_ls"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const agent = config.agents.list.find((a: { id: string }) => a.id === "power-agent-id");

    expect(agent.tools.deny).not.toContain("group:runtime");
    expect(agent.tools.deny).toContain("group:fs");
    expect(agent.tools.deny).toContain("group:web");
  });

  it("should include pinchy-files plugin config for agents with safe tools", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: { allowed_paths: ["/data/hr-docs/", "/data/policies/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.entries["pinchy-files"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-files"].config.agents["kb-agent-id"]).toEqual({
      allowed_paths: ["/data/hr-docs/", "/data/policies/"],
    });
  });

  it("should not keep stale env vars from previous config", async () => {
    const existingConfig = {
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "existing-token" },
      },
      env: {
        ANTHROPIC_API_KEY: "old-key",
        OPENAI_API_KEY: "stale-key-should-be-removed",
      },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    // Only Anthropic is configured now
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-new";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-new");
    expect(config.env.OPENAI_API_KEY).toBeUndefined();
    expect(config.gateway.auth.token).toBe("existing-token");
  });

  it("should include pinchy-context plugin config for agents with context tools", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-context"].config.apiBaseUrl).toBe("http://pinchy:7777");
    expect(config.plugins.entries["pinchy-context"].config.gatewayToken).toBe("gw-token-123");
    expect(config.plugins.entries["pinchy-context"].config.agents["smithers-1"]).toEqual({
      tools: ["save_user_context"],
      userId: "user-1",
    });
  });

  it("should include pinchy-audit plugin config", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-audit"]).toBeDefined();
    expect(config.plugins.entries["pinchy-audit"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-audit"].config).toEqual({
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "gw-token-123",
    });
  });

  it("should use PORT env var in plugin apiBaseUrl when set", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    // Simulate custom port
    const originalPort = process.env.PORT;
    process.env.PORT = "7778";

    try {
      mockedDb.select.mockReturnValue({
        from: vi.fn().mockResolvedValue([
          {
            id: "smithers-1",
            name: "Smithers",
            model: "anthropic/claude-sonnet-4-20250514",
            pluginConfig: null,
            allowedTools: ["pinchy_save_user_context"],
            ownerId: "user-1",
            isPersonal: true,
            createdAt: new Date(),
          },
        ]),
      } as never);

      await regenerateOpenClawConfig();

      const written = mockedWriteFileSync.mock.calls[0][1] as string;
      const config = JSON.parse(written);

      expect(config.plugins.entries["pinchy-audit"].config.apiBaseUrl).toBe("http://pinchy:7778");
      expect(config.plugins.entries["pinchy-context"].config.apiBaseUrl).toBe("http://pinchy:7778");
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });

  it("should include both pinchy-files and pinchy-context when agents use both", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
        {
          id: "kb-agent",
          name: "KB Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: { allowed_paths: ["/data/docs/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          ownerId: null,
          isPersonal: false,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
  });

  it("should include both save tools for admin Smithers", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "admin-smithers",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context", "pinchy_save_org_context"],
          ownerId: "admin-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-context"].config.agents["admin-smithers"]).toEqual({
      tools: ["save_user_context", "save_org_context"],
      userId: "admin-1",
    });
  });

  it("should omit pinchy-context and pinchy-files when no agents use them", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "custom-agent-id",
          name: "Dev Assistant",
          model: "anthropic/claude-opus-4-6",
          templateId: "custom",
          pluginConfig: null,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // Unused plugins are omitted from entries AND allow list to prevent
    // auto-discovery (restart loop) and "disabled but config present" spam
    expect(config.plugins.entries["pinchy-context"]).toBeUndefined();
    expect(config.plugins.entries["pinchy-files"]).toBeUndefined();
    expect(config.plugins.allow).not.toContain("pinchy-context");
    expect(config.plugins.allow).not.toContain("pinchy-files");
    // pinchy-audit is always enabled to capture tool usage at source
    expect(config.plugins.entries["pinchy-audit"].enabled).toBe(true);
    expect(config.plugins.allow).toContain("pinchy-audit");
  });
});

describe("restart-state integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("writeOpenClawConfig calls restartState.notifyRestart", async () => {
    const { restartState } = await import("@/server/restart-state");

    writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(restartState.notifyRestart).toHaveBeenCalledOnce();
  });

  it("regenerateOpenClawConfig calls restartState.notifyRestart", async () => {
    const { restartState } = await import("@/server/restart-state");

    await regenerateOpenClawConfig();

    expect(restartState.notifyRestart).toHaveBeenCalledOnce();
  });

  it("should skip writing and not restart when config content is unchanged", async () => {
    const { restartState } = await import("@/server/restart-state");

    // First call writes the config
    await regenerateOpenClawConfig();
    const firstWrite = mockedWriteFileSync.mock.calls[0][1] as string;

    vi.clearAllMocks();
    // Mock readFileSync to return what was just written
    mockedReadFileSync.mockReturnValue(firstWrite);
    mockedExistsSync.mockReturnValue(true);
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as never);
    mockedGetSetting.mockResolvedValue(null);

    // Second call should skip writing
    await regenerateOpenClawConfig();

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(restartState.notifyRestart).not.toHaveBeenCalled();
  });

  it("should include Telegram channel config when bot token is configured", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "123456:ABC-token";
      if (key === "telegram_bot_username:agent-1") return "acme_smithers_bot";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.channels.telegram).toEqual({
      enabled: true,
      botToken: "123456:ABC-token",
      dmPolicy: "pairing",
    });
    expect(config.bindings).toEqual([{ agentId: "agent-1", match: { channel: "telegram" } }]);
    expect(config.session.dmScope).toBe("per-peer");
  });

  it("should not include Telegram config when no bot token is configured", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "agent-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.channels).toBeUndefined();
    expect(config.bindings).toBeUndefined();
  });

  it("should include identityLinks from channel_links table", async () => {
    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: agents table
          return Promise.resolve([
            { id: "agent-1", name: "Smithers", model: "m", allowedTools: [] },
          ]);
        }
        // Second call: channel_links table
        return Promise.resolve([
          { userId: "user-1", channel: "telegram", channelUserId: "999888" },
        ]);
      }),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "token";
      if (key === "telegram_bot_username:agent-1") return "bot";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.session.identityLinks).toEqual({
      "user-1": ["telegram:999888"],
    });
  });
});

// ── applyConfigPatch ─────────────────────────────────────────────────────

import { applyConfigPatch, pushStartupConfig } from "@/lib/openclaw-config";

describe("applyConfigPatch", () => {
  function mockClient(overrides?: {
    getResult?: unknown;
    getError?: Error;
    patchResult?: unknown;
    patchError?: Error;
  }) {
    return {
      config: {
        get: vi.fn().mockImplementation(() => {
          if (overrides?.getError) return Promise.reject(overrides.getError);
          return Promise.resolve(overrides?.getResult ?? { hash: "hash-1" });
        }),
        patch: vi.fn().mockImplementation(() => {
          if (overrides?.patchError) return Promise.reject(overrides.patchError);
          return Promise.resolve(overrides?.patchResult ?? { payload: {} });
        }),
      },
    };
  }

  it("should return applied: true on success", async () => {
    const client = mockClient();
    const result = await applyConfigPatch(client as any, { foo: "bar" });

    expect(result).toEqual({ applied: true });
    expect(client.config.get).toHaveBeenCalledOnce();
    expect(client.config.patch).toHaveBeenCalledWith('{"foo":"bar"}', "hash-1");
  });

  it("should retry once on hash conflict and succeed", async () => {
    const client = mockClient();
    client.config.patch
      .mockRejectedValueOnce(new Error("hash_mismatch"))
      .mockResolvedValueOnce({ payload: {} });
    client.config.get
      .mockResolvedValueOnce({ hash: "hash-1" })
      .mockResolvedValueOnce({ hash: "hash-2" });

    const result = await applyConfigPatch(client as any, { foo: "bar" });

    expect(result).toEqual({ applied: true });
    expect(client.config.get).toHaveBeenCalledTimes(2);
    expect(client.config.patch).toHaveBeenCalledTimes(2);
    expect(client.config.patch).toHaveBeenLastCalledWith('{"foo":"bar"}', "hash-2");
  });

  it("should return applied: false when both attempts fail with hash conflict", async () => {
    const client = mockClient();
    client.config.patch.mockRejectedValue(new Error("hash_mismatch"));
    client.config.get
      .mockResolvedValueOnce({ hash: "hash-1" })
      .mockResolvedValueOnce({ hash: "hash-2" });

    const result = await applyConfigPatch(client as any, { foo: "bar" });

    expect(result).toEqual({ applied: false, error: "hash_mismatch" });
  });

  it("should treat timeout/disconnect as success (OpenClaw restarted)", async () => {
    const client = mockClient();
    client.config.patch.mockRejectedValueOnce(new Error("Request config.patch timed out"));

    const result = await applyConfigPatch(client as any, { foo: "bar" });

    expect(result).toEqual({ applied: true });
    expect(client.config.patch).toHaveBeenCalledOnce();
  });

  it("should return applied: false when config.get fails", async () => {
    const client = mockClient({ getError: new Error("not connected") });

    const result = await applyConfigPatch(client as any, { foo: "bar" });

    expect(result).toEqual({ applied: false, error: "not connected" });
    expect(client.config.patch).not.toHaveBeenCalled();
  });
});

// ── pushStartupConfig ────────────────────────────────────────────────────

describe("pushStartupConfig", () => {
  function mockClient(overrides?: { getResult?: unknown; patchError?: Error }) {
    return {
      config: {
        get: vi.fn().mockResolvedValue(overrides?.getResult ?? { hash: "h1" }),
        patch: vi.fn().mockImplementation(() => {
          if (overrides?.patchError) return Promise.reject(overrides.patchError);
          return Promise.resolve({ payload: {} });
        }),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("reads config file and pushes via applyConfigPatch", async () => {
    const configContent = {
      gateway: { mode: "local", auth: { token: "t" } },
      channels: { telegram: { enabled: true, botToken: "tok" } },
      bindings: [{ agentId: "a1", match: { channel: "telegram" } }],
      agents: { list: [{ id: "a1", name: "Smithers" }] },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(configContent));

    const client = mockClient();
    const result = await pushStartupConfig(client as any);

    expect(result).toEqual({ applied: true });
    expect(client.config.patch).toHaveBeenCalled();
    const patchArg = JSON.parse(client.config.patch.mock.calls[0][0]);
    expect(patchArg.channels.telegram.enabled).toBe(true);
    expect(patchArg.bindings).toEqual([{ agentId: "a1", match: { channel: "telegram" } }]);
  });

  it("returns applied: false when config file does not exist", async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const client = mockClient();
    const result = await pushStartupConfig(client as any);

    expect(result).toEqual({ applied: false, error: expect.stringContaining("ENOENT") });
    expect(client.config.patch).not.toHaveBeenCalled();
  });

  it("returns applied: false when config file is invalid JSON", async () => {
    mockedReadFileSync.mockReturnValue("not-json{{{");

    const client = mockClient();
    const result = await pushStartupConfig(client as any);

    expect(result.applied).toBe(false);
    expect(client.config.patch).not.toHaveBeenCalled();
  });
});
