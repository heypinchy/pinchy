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
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockResolvedValue([]),
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

vi.mock("@/lib/provider-models", () => {
  const defaults: Record<string, string> = {
    anthropic: "anthropic/claude-haiku-4-5-20251001",
    openai: "openai/gpt-4o-mini",
    google: "google/gemini-2.5-flash",
    "ollama-cloud": "ollama-cloud/gemini-3-flash-preview",
    "ollama-local": "",
  };
  return {
    getDefaultModel: vi.fn(async (provider: string) => defaults[provider] ?? ""),
  };
});

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import {
  regenerateOpenClawConfig,
  updateIdentityLinks,
  sanitizeOpenClawConfig,
} from "@/lib/openclaw-config";
import { db } from "@/db";
import { getSetting } from "@/lib/settings";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

const mockedDb = vi.mocked(db);
const mockedGetSetting = vi.mocked(getSetting);

/** Helper: create a mock `from()` that returns a thenable with `.innerJoin()` */
function mockFrom(data: unknown[] = []) {
  return vi.fn().mockImplementation(() =>
    Object.assign(Promise.resolve(data), {
      innerJoin: vi.fn().mockResolvedValue([]),
    })
  );
}

describe("regenerateOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedDb.select.mockReturnValue({
      from: mockFrom(),
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

  it("should disable heartbeat per agent in agents.list", async () => {
    // Rationale: Heartbeat fires LLM calls in the background and racks up
    // tokens for every agent, even idle ones. Pinchy disables it by default
    // (`heartbeat: { every: "0m" }`). We set it per-agent, NOT on agents.defaults,
    // to avoid hot-reload races with Telegram (openclaw#47458).
    const agentsData = [
      { id: "a1", name: "Smithers", model: "anthropic/claude-opus-4-6", createdAt: new Date() },
      { id: "a2", name: "Jeeves", model: "openai/gpt-4o", createdAt: new Date() },
    ];
    mockedDb.select.mockReturnValue({
      from: mockFrom(agentsData),
    } as never);
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const config = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    for (const agent of config.agents.list) {
      expect(agent.heartbeat).toEqual({ every: "0m" });
    }
    // Must NOT be in agents.defaults (would cause hot-reload loops)
    expect(config.agents.defaults?.heartbeat).toBeUndefined();
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
      from: mockFrom(agentsData),
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
      heartbeat: { every: "0m" },
    });
    expect(config.agents.list[1]).toEqual({
      id: "uuid-agent-2",
      name: "Jeeves",
      model: "openai/gpt-4o",
      workspace: "/root/.openclaw/workspaces/uuid-agent-2",
      tools: { deny: ["group:runtime", "group:fs", "group:web", "pdf", "image", "image_generate"] },
      heartbeat: { every: "0m" },
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
      from: mockFrom(),
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
      from: mockFrom([
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
      from: mockFrom([
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

  it("should include pinchy-files plugin config for agents with safe tools", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
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

  it("should include apiBaseUrl and gatewayToken in pinchy-files config so the plugin can report vision token usage", async () => {
    const existingConfig = {
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-files" } },
    };
    mockedReadFileSync.mockReturnValue(JSON.stringify(existingConfig));

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: { allowed_paths: ["/data/hr-docs/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // apiBaseUrl and gatewayToken live at the plugin-level config (alongside `agents`),
    // matching how pinchy-context and pinchy-audit expose them.
    expect(config.plugins.entries["pinchy-files"].config.apiBaseUrl).toBe("http://pinchy:7777");
    expect(config.plugins.entries["pinchy-files"].config.gatewayToken).toBe("gw-token-files");
    // Per-agent allowed_paths is still nested under .agents
    expect(config.plugins.entries["pinchy-files"].config.agents["kb-agent-id"]).toEqual({
      allowed_paths: ["/data/hr-docs/"],
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
      from: mockFrom([
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
        from: mockFrom([
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
      from: mockFrom([
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
      from: mockFrom([
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

  it("should include ollama-cloud provider config when ollama_cloud_api_key is set", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
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

  it("writes every tool-capable Ollama Cloud model into the config", async () => {
    // OpenClaw reads this list to know which cloud models exist and how to
    // prune their context. A mismatch between what Pinchy's UI lets the
    // admin pick and what OpenClaw knows about means the agent would run
    // with default context hints (or refuse the model entirely). Keep the
    // lists locked.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const modelIds = (config.models.providers["ollama-cloud"].models as Array<{ id: string }>).map(
      (m) => m.id
    );

    expect(modelIds.sort()).toEqual(
      [
        "deepseek-v3.1:671b",
        "deepseek-v3.2",
        "devstral-2:123b",
        "devstral-small-2:24b",
        "gemini-3-flash-preview",
        "gemma4:31b",
        "glm-4.6",
        "glm-4.7",
        "glm-5",
        "glm-5.1",
        "gpt-oss:120b",
        "gpt-oss:20b",
        "kimi-k2-thinking",
        "kimi-k2.5",
        "minimax-m2",
        "minimax-m2.1",
        "minimax-m2.5",
        "minimax-m2.7",
        "ministral-3:14b",
        "ministral-3:3b",
        "ministral-3:8b",
        "mistral-large-3:675b",
        "nemotron-3-nano:30b",
        "nemotron-3-super",
        "qwen3-coder-next",
        "qwen3-coder:480b",
        "qwen3-next:80b",
        "qwen3-vl:235b",
        "qwen3-vl:235b-instruct",
        "qwen3.5:397b",
        "rnj-1:8b",
      ].sort()
    );
  });

  it("writes the correct context window for each Ollama Cloud model", async () => {
    // Context windows are taken from each model's ollama.com/library/<name>
    // page. Pinchy must not exceed the real limit (Ollama would reject the
    // request) and shouldn't under-report either (unnecessary compaction).
    // Ollama's "NK" convention is N * 1024, which we preserve here.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const models = config.models.providers["ollama-cloud"].models as Array<{
      id: string;
      contextWindow: number;
    }>;
    const ctx = Object.fromEntries(models.map((m) => [m.id, m.contextWindow]));

    // 32K — smallest in the list, was previously over-reported as 128K
    expect(ctx["rnj-1:8b"]).toBe(32768);
    // 128K
    expect(ctx["gpt-oss:20b"]).toBe(131072);
    expect(ctx["gpt-oss:120b"]).toBe(131072);
    // 160K
    expect(ctx["deepseek-v3.1:671b"]).toBe(163840);
    expect(ctx["deepseek-v3.2"]).toBe(163840);
    // 198K (GLM family, minimax-m2.5)
    expect(ctx["glm-4.6"]).toBe(202752);
    expect(ctx["glm-4.7"]).toBe(202752);
    expect(ctx["glm-5"]).toBe(202752);
    expect(ctx["glm-5.1"]).toBe(202752);
    expect(ctx["minimax-m2.5"]).toBe(202752);
    // 200K (other minimax variants)
    expect(ctx["minimax-m2"]).toBe(204800);
    expect(ctx["minimax-m2.1"]).toBe(204800);
    expect(ctx["minimax-m2.7"]).toBe(204800);
    // 256K — the most common class
    expect(ctx["devstral-2:123b"]).toBe(262144);
    expect(ctx["gemma4:31b"]).toBe(262144);
    expect(ctx["kimi-k2-thinking"]).toBe(262144);
    expect(ctx["kimi-k2.5"]).toBe(262144);
    expect(ctx["ministral-3:3b"]).toBe(262144);
    expect(ctx["ministral-3:8b"]).toBe(262144);
    expect(ctx["ministral-3:14b"]).toBe(262144);
    expect(ctx["mistral-large-3:675b"]).toBe(262144);
    expect(ctx["nemotron-3-super"]).toBe(262144);
    expect(ctx["qwen3-coder-next"]).toBe(262144);
    expect(ctx["qwen3-coder:480b"]).toBe(262144);
    expect(ctx["qwen3-next:80b"]).toBe(262144);
    expect(ctx["qwen3-vl:235b"]).toBe(262144);
    expect(ctx["qwen3-vl:235b-instruct"]).toBe(262144);
    expect(ctx["qwen3.5:397b"]).toBe(262144);
    // 384K
    expect(ctx["devstral-small-2:24b"]).toBe(393216);
    // 1M
    expect(ctx["gemini-3-flash-preview"]).toBe(1048576);
    expect(ctx["nemotron-3-nano:30b"]).toBe(1048576);
  });

  it("opts every Ollama Cloud model into streaming usage reporting", async () => {
    // Ollama Cloud's /v1/chat/completions only emits a final `usage` chunk
    // when the request carries `stream_options: { include_usage: true }`.
    // OpenClaw adds that flag only when the model config opts in via
    // `compat.supportsUsageInStreaming: true` — its own auto-detection
    // treats configured non-OpenAI endpoints as "not supported" by default.
    // Without this opt-in, sessions have no inputTokens/outputTokens, the
    // poller records nothing, and Usage & Costs stays empty.
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);
    const models = config.models.providers["ollama-cloud"].models as Array<{
      id: string;
      compat?: { supportsUsageInStreaming?: boolean };
    }>;

    for (const model of models) {
      expect(model.compat?.supportsUsageInStreaming).toBe(true);
    }
  });

  it("should not include models block when neither ollama provider is configured", async () => {
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models).toBeUndefined();
  });

  it("should include local ollama provider config when ollama_local_url is set", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"]).toBeDefined();
    expect(config.models.providers["ollama"].baseUrl).toBe("http://host.docker.internal:11434");
    expect(config.models.providers["ollama"].api).toBe("ollama");
    expect(config.models.providers["ollama"].models).toEqual([]);
  });

  it("should include both ollama providers when both are configured", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-cloud";
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama-cloud"]).toBeDefined();
    expect(config.models.providers["ollama"]).toBeDefined();
  });

  it("should strip trailing slash from ollama local URL", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434/";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.models.providers["ollama"].baseUrl).toBe("http://host.docker.internal:11434");
  });

  it("should not add empty env var for ollama-local provider", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://host.docker.internal:11434";
      return null;
    });

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    // ollama-local has envVar: "" — should not appear as empty key in env
    expect(config.env[""]).toBeUndefined();
  });

  it("should omit pinchy-context and pinchy-files when no agents use them", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
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
    expect(config.plugins.entries["pinchy-docs"]).toBeUndefined();
    expect(config.plugins.allow).not.toContain("pinchy-context");
    expect(config.plugins.allow).not.toContain("pinchy-files");
    expect(config.plugins.allow).not.toContain("pinchy-docs");
    // pinchy-audit is always enabled to capture tool usage at source
    expect(config.plugins.entries["pinchy-audit"].enabled).toBe(true);
    expect(config.plugins.allow).toContain("pinchy-audit");
  });

  it("strips stale pinchy-* plugins from allow list when they have no entries", async () => {
    // Simulate a config that was written before some plugins were removed —
    // e.g. pinchy-files and pinchy-odoo are in allow but no agent uses them.
    // OpenClaw rejects plugins in allow without valid config, so we must clean up.
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { mode: "token", token: "tok" } },
        plugins: {
          allow: ["pinchy-files", "pinchy-context", "pinchy-audit", "pinchy-odoo", "telegram"],
          entries: {},
        },
      })
    );

    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "agent-1",
          name: "Dev",
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

    // pinchy-files and pinchy-odoo have no entries → must be removed from allow
    expect(config.plugins.allow).not.toContain("pinchy-files");
    expect(config.plugins.allow).not.toContain("pinchy-odoo");
    // Non-pinchy plugins (OpenClaw-managed) must be preserved
    expect(config.plugins.allow).toContain("telegram");
    // pinchy-audit is always enabled
    expect(config.plugins.allow).toContain("pinchy-audit");
  });

  it("enables pinchy-docs plugin with personal agent ids when personal agents exist", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: true,
          ownerId: "user-1",
          allowedTools: ["pinchy_save_user_context"],
          createdAt: new Date(),
        },
        {
          id: "shared-1",
          name: "Shared",
          model: "anthropic/claude-haiku-4-5-20251001",
          isPersonal: false,
          ownerId: null,
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins.entries["pinchy-docs"]).toBeDefined();
    expect(config.plugins.entries["pinchy-docs"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-docs"].config.docsPath).toBe("/pinchy-docs");
    expect(config.plugins.entries["pinchy-docs"].config.agents).toEqual({
      "smithers-1": {},
    });
    expect(config.plugins.allow).toContain("pinchy-docs");
  });
});

describe("sanitizeOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("removes stale pinchy-* plugins from allow that have no entries", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local" },
        plugins: {
          allow: ["pinchy-files", "pinchy-audit", "pinchy-odoo", "telegram"],
          entries: {
            "pinchy-audit": { enabled: true, config: {} },
          },
        },
      })
    );

    const changed = sanitizeOpenClawConfig();

    expect(changed).toBe(true);
    const written = JSON.parse(mockedWriteFileSync.mock.calls[0][1] as string);
    expect(written.plugins.allow).toContain("pinchy-audit");
    expect(written.plugins.allow).toContain("telegram");
    expect(written.plugins.allow).not.toContain("pinchy-files");
    expect(written.plugins.allow).not.toContain("pinchy-odoo");
  });

  it("returns false and does not write when allow list is already clean", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local" },
        plugins: {
          allow: ["pinchy-audit", "telegram"],
          entries: {
            "pinchy-audit": { enabled: true, config: {} },
          },
        },
      })
    );

    const changed = sanitizeOpenClawConfig();

    expect(changed).toBe(false);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("returns false when config file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);

    const changed = sanitizeOpenClawConfig();

    expect(changed).toBe(false);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});

describe("pinchy-odoo config size", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("should include only modelNames, not full schema with fields", async () => {
    const agentsData = [
      {
        id: "odoo-agent",
        name: "Odoo Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["odoo_read"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "odoo-agent",
          connectionId: "conn-1",
          model: "sale.order",
          operation: "read",
        },
        integration_connections: {
          id: "conn-1",
          type: "odoo",
          name: "Test Odoo",
          description: "",
          credentials: JSON.stringify({
            url: "https://odoo.test",
            db: "test",
            uid: 2,
            apiKey: "key",
          }),
          data: {
            models: [
              {
                model: "sale.order",
                name: "Sales Orders",
                fields: [
                  { name: "id", string: "ID", type: "integer", required: true, readonly: true },
                ],
                access: { read: true, create: false, write: false, delete: false },
              },
              {
                model: "res.partner",
                name: "Contacts",
                fields: [
                  { name: "id", string: "ID", type: "integer", required: true, readonly: true },
                ],
                access: { read: true, create: true, write: true, delete: false },
              },
            ],
            lastSyncAt: "2026-04-01T00:00:00Z",
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(agentsData), {
          innerJoin: vi.fn().mockResolvedValue(permissionsData),
        })
      ),
    } as never);

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const odooConfig = config.plugins?.entries?.["pinchy-odoo"]?.config?.agents?.["odoo-agent"];
    expect(odooConfig).toBeDefined();

    // Should have modelNames (lightweight)
    expect(odooConfig.modelNames).toEqual({ "sale.order": "Sales Orders" });

    // Should NOT have full schema with fields
    expect(odooConfig.schema).toBeUndefined();

    // Config should be small (no field definitions bloating it)
    const configSize = written.length;
    expect(configSize).toBeLessThan(5000); // Without schema: ~2-3KB. With schema it would be 100KB+
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
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
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
      from: mockFrom(),
    } as never);
    mockedGetSetting.mockResolvedValue(null);

    // Second call should skip writing
    await regenerateOpenClawConfig();

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(restartState.notifyRestart).not.toHaveBeenCalled();
  });

  it("should include Telegram channel config with accounts format when bot token is configured", async () => {
    mockedDb.select.mockReturnValue({
      from: mockFrom([
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
          return Object.assign(
            Promise.resolve([
              { id: "agent-1", name: "Smithers", model: "m", allowedTools: [] },
              { id: "agent-2", name: "Support", model: "m", allowedTools: [] },
            ]),
            { innerJoin: vi.fn().mockResolvedValue([]) }
          );
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockResolvedValue([]),
        });
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
          return Object.assign(
            Promise.resolve([
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
            ]),
            { innerJoin: vi.fn().mockResolvedValue([]) }
          );
        }
        // callCount 2 = agentConnectionPermissions (chained with innerJoin)
        // callCount 3 = channel_links table: both users linked
        if (callCount === 3) {
          return Object.assign(
            Promise.resolve([
              { userId: "user-a", channel: "telegram", channelUserId: "111222333" },
              { userId: "user-b", channel: "telegram", channelUserId: "444555666" },
            ]),
            { innerJoin: vi.fn().mockResolvedValue([]) }
          );
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockResolvedValue([]),
        });
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
      from: mockFrom([
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
          return Object.assign(
            Promise.resolve([{ id: "agent-1", name: "Smithers", model: "m", allowedTools: [] }]),
            { innerJoin: vi.fn().mockResolvedValue([]) }
          );
        }
        // callCount 2 = agentConnectionPermissions (chained with innerJoin)
        // callCount 3 = channel_links table
        if (callCount === 3) {
          return Object.assign(
            Promise.resolve([{ userId: "user-1", channel: "telegram", channelUserId: "999888" }]),
            { innerJoin: vi.fn().mockResolvedValue([]) }
          );
        }
        return Object.assign(Promise.resolve([]), {
          innerJoin: vi.fn().mockResolvedValue([]),
        });
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
