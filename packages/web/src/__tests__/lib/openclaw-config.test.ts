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
      { encoding: "utf-8", mode: 0o600 }
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
      model: "google/gemini-2.0-flash",
    });

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.env.GOOGLE_API_KEY).toBe("AIza-key");
    expect(config.agents.defaults.model.primary).toBe("google/gemini-2.0-flash");
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
      mode: 0o600,
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
      mode: 0o600,
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
      tools: { deny: ["group:runtime", "group:fs", "group:web"] },
    });
    expect(config.agents.list[1]).toEqual({
      id: "uuid-agent-2",
      name: "Jeeves",
      model: "openai/gpt-4o",
      workspace: "/root/.openclaw/workspaces/uuid-agent-2",
      tools: { deny: ["group:runtime", "group:fs", "group:web"] },
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
    expect(config.env.GOOGLE_API_KEY).toBeUndefined();
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

  it("should not include plugin config when no agents use it", async () => {
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

    expect(config.plugins).toBeUndefined();
  });
});
