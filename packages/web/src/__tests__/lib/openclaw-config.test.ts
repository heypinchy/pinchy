import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  const renameSyncMock = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: writeFileSyncMock,
      readFileSync: readFileSyncMock,
      existsSync: existsSyncMock,
      mkdirSync: mkdirSyncMock,
      renameSync: renameSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
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
import {
  writeOpenClawConfig,
  regenerateOpenClawConfig,
  updateIdentityLinks,
} from "@/lib/openclaw-config";
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
    // OpenClaw-enriched fields (meta, commands, agents.defaults.*) are preserved
    // to avoid unnecessary diffs that trigger hot-reloads breaking Telegram polling
    expect(config.meta).toEqual({ version: "1.2.3", generatedAt: "2025-01-01T00:00:00Z" });
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

  it("should include ollama-cloud provider config when ollama_api_key is set", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models).toBeDefined();
    expect(config.models.providers["ollama-cloud"]).toBeDefined();
    expect(config.models.providers["ollama-cloud"].baseUrl).toBe("https://ollama.com/v1");
    expect(config.models.providers["ollama-cloud"].apiKey).toBe("sk-ollama-test");
    expect(config.models.providers["ollama-cloud"].api).toBe("openai-completions");
    expect(Array.isArray(config.models.providers["ollama-cloud"].models)).toBe(true);
    expect(config.models.providers["ollama-cloud"].models.length).toBeGreaterThan(0);
  });

  it("should not include models block when ollama_api_key is not set", async () => {
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models).toBeUndefined();
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

  it("regenerateOpenClawConfig does not call restartState.notifyRestart (OpenClaw detects file changes)", async () => {
    const { restartState } = await import("@/server/restart-state");

    await regenerateOpenClawConfig();

    expect(restartState.notifyRestart).not.toHaveBeenCalled();
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

  it("should include Telegram channel config with accounts format when bot token is configured", async () => {
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
      dmPolicy: "pairing",
      accounts: {
        "agent-1": { botToken: "123456:ABC-token" },
      },
    });
    expect(config.bindings).toEqual([
      { agentId: "agent-1", match: { channel: "telegram", accountId: "agent-1" } },
    ]);
    expect(config.session.dmScope).toBe("per-peer");
  });

  it("should include multiple accounts when multiple agents have bots", async () => {
    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            { id: "agent-1", name: "Smithers", model: "m", allowedTools: [] },
            { id: "agent-2", name: "Support", model: "m", allowedTools: [] },
          ]);
        }
        return Promise.resolve([]);
      }),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:agent-1") return "token-1";
      if (key === "telegram_bot_token:agent-2") return "token-2";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.channels.telegram.accounts).toEqual({
      "agent-1": { botToken: "token-1" },
      "agent-2": { botToken: "token-2" },
    });
    expect(config.bindings).toEqual([
      { agentId: "agent-1", match: { channel: "telegram", accountId: "agent-1" } },
      { agentId: "agent-2", match: { channel: "telegram", accountId: "agent-2" } },
    ]);
  });

  it("should generate per-user peer bindings for personal agents (Smithers)", async () => {
    // Personal agent (Smithers) with bot token: each linked user should get
    // a peer-specific binding routing to their OWN personal Smithers agent.
    let callCount = 0;
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // agents table: admin's Smithers has the bot, plus user-b's Smithers
          return Promise.resolve([
            {
              id: "admin-smithers",
              name: "Smithers",
              model: "m",
              allowedTools: [],
              isPersonal: true,
              ownerId: "user-a",
            },
            {
              id: "user-b-smithers",
              name: "Smithers",
              model: "m",
              allowedTools: [],
              isPersonal: true,
              ownerId: "user-b",
            },
          ]);
        }
        // channel_links table: both users linked
        return Promise.resolve([
          { userId: "user-a", channel: "telegram", channelUserId: "111222333" },
          { userId: "user-b", channel: "telegram", channelUserId: "444555666" },
        ]);
      }),
    } as never);

    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "telegram_bot_token:admin-smithers") return "123456:ABC-token";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // One account for the bot
    expect(config.channels.telegram.accounts).toEqual({
      "admin-smithers": { botToken: "123456:ABC-token" },
    });

    // Per-user peer bindings: user-a → admin-smithers, user-b → user-b-smithers
    expect(config.bindings).toEqual(
      expect.arrayContaining([
        {
          agentId: "admin-smithers",
          match: {
            channel: "telegram",
            accountId: "admin-smithers",
            peer: { kind: "dm", id: "111222333" },
          },
        },
        {
          agentId: "user-b-smithers",
          match: {
            channel: "telegram",
            accountId: "admin-smithers",
            peer: { kind: "dm", id: "444555666" },
          },
        },
      ])
    );
    // No generic binding without peer (all users are routed via peer-specific bindings)
    const genericBinding = config.bindings.find(
      (b: Record<string, unknown>) => (b.match as Record<string, unknown>).peer === undefined
    );
    expect(genericBinding).toBeUndefined();
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

describe("updateIdentityLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("should only update session.identityLinks without touching other fields", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "secret" } },
      env: { ANTHROPIC_API_KEY: "sk-ant-key" },
      agents: {
        defaults: { model: { primary: "anthropic/claude" }, heartbeat: { intervalMs: 1800000 } },
        list: [{ id: "agent-1", name: "Smithers" }],
      },
      channels: { telegram: { enabled: true, botToken: "123:abc", dmPolicy: "pairing" } },
      plugins: { allow: ["telegram", "pinchy-audit"], entries: {} },
      meta: { version: "1.0" },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    const { updateIdentityLinks } = await import("@/lib/openclaw-config");
    await updateIdentityLinks({ "user-1": ["telegram:8754697762"] });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);

    // identityLinks updated
    expect(written.session.identityLinks).toEqual({ "user-1": ["telegram:8754697762"] });

    // Everything else preserved exactly
    expect(written.agents.defaults.heartbeat).toEqual({ intervalMs: 1800000 });
    expect(written.agents.defaults.model).toEqual({ primary: "anthropic/claude" });
    expect(written.agents.list).toEqual([{ id: "agent-1", name: "Smithers" }]);
    expect(written.env.ANTHROPIC_API_KEY).toBe("sk-ant-key");
    expect(written.plugins.allow).toEqual(["telegram", "pinchy-audit"]);
    expect(written.meta.version).toBe("1.0");
    expect(written.channels.telegram.botToken).toBe("123:abc");
  });

  it("should remove identityLinks when called with empty object", async () => {
    const existingConfig = {
      gateway: { mode: "local" },
      session: { dmScope: "per-peer", identityLinks: { "user-1": ["telegram:123"] } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    const { updateIdentityLinks } = await import("@/lib/openclaw-config");
    await updateIdentityLinks({});

    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written.session.identityLinks).toEqual({});
    expect(written.session.dmScope).toBe("per-peer");
    expect(written.gateway.mode).toBe("local");
  });

  it("should skip write when identityLinks unchanged", async () => {
    const existingConfig = {
      gateway: { mode: "local" },
      session: { identityLinks: { "user-1": ["telegram:123"] } },
    };
    // readFileSync is called twice: once by readExistingConfig, once by the skip-if-unchanged check.
    // Both must return the same content that would be produced by JSON.stringify(updated, null, 2).
    const serialized = JSON.stringify(existingConfig, null, 2);
    mockedReadFileSync.mockReturnValue(serialized);

    const { updateIdentityLinks } = await import("@/lib/openclaw-config");
    updateIdentityLinks({ "user-1": ["telegram:123"] });

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});
