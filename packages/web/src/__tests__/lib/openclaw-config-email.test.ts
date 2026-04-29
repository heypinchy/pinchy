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

describe("pinchy-email config generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    mockedGetSetting.mockResolvedValue(null);
  });

  it("should include pinchy-email plugin when agent has email permissions (type=google)", async () => {
    const agentsData = [
      {
        id: "email-agent",
        name: "Email Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["email_list", "email_read"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "email-agent",
          connectionId: "conn-google-1",
          model: "email",
          operation: "read",
        },
        integration_connections: {
          id: "conn-google-1",
          type: "google",
          name: "Work Gmail",
          description: "Work email account",
          credentials: JSON.stringify({
            accessToken: "secret-access-token",
            refreshToken: "secret-refresh-token",
            clientId: "secret-client-id",
            clientSecret: "secret-client-secret",
          }),
          data: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

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

    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
      })
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const emailPlugin = config.plugins?.entries?.["pinchy-email"];
    expect(emailPlugin).toBeDefined();
    expect(emailPlugin.enabled).toBe(true);
  });

  it("should include apiBaseUrl, gatewayToken, connectionId, and permissions in email config", async () => {
    const agentsData = [
      {
        id: "email-agent",
        name: "Email Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["email_list", "email_read", "email_draft"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "email-agent",
          connectionId: "conn-google-1",
          model: "email",
          operation: "read",
        },
        integration_connections: {
          id: "conn-google-1",
          type: "google",
          name: "Work Gmail",
          description: "",
          credentials: JSON.stringify({
            accessToken: "secret-token",
            refreshToken: "secret-refresh",
          }),
          data: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      {
        agent_connection_permissions: {
          agentId: "email-agent",
          connectionId: "conn-google-1",
          model: "email",
          operation: "draft",
        },
        integration_connections: {
          id: "conn-google-1",
          type: "google",
          name: "Work Gmail",
          description: "",
          credentials: JSON.stringify({
            accessToken: "secret-token",
            refreshToken: "secret-refresh",
          }),
          data: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

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

    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
      })
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const emailConfig = config.plugins.entries["pinchy-email"].config;
    expect(emailConfig.apiBaseUrl).toBe("http://pinchy:7777");
    // gatewayToken is a plain string — OpenClaw 2026.4.26 does not resolve
    // SecretRef in plugins.entries.*.config (the config validator requires
    // a literal string).
    expect(typeof emailConfig.gatewayToken).toBe("string");

    const agentConfig = emailConfig.agents["email-agent"];
    expect(agentConfig.connectionId).toBe("conn-google-1");
    expect(agentConfig.permissions).toEqual({ email: ["read", "draft"] });
  });

  it("should NOT include any credentials in email config", async () => {
    const agentsData = [
      {
        id: "email-agent",
        name: "Email Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["email_read"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "email-agent",
          connectionId: "conn-ms-1",
          model: "email",
          operation: "read",
        },
        integration_connections: {
          id: "conn-ms-1",
          type: "microsoft",
          name: "Outlook",
          description: "",
          credentials: JSON.stringify({
            accessToken: "super-secret-access",
            refreshToken: "super-secret-refresh",
            clientId: "client-id-123",
            clientSecret: "client-secret-456",
          }),
          data: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

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

    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
      })
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;

    // The entire serialized config must not contain any credential values
    expect(written).not.toContain("super-secret-access");
    expect(written).not.toContain("super-secret-refresh");
    expect(written).not.toContain("client-id-123");
    expect(written).not.toContain("client-secret-456");

    // Double-check: agent config should only have connectionId + permissions
    const config = JSON.parse(written);
    const agentConfig = config.plugins.entries["pinchy-email"].config.agents["email-agent"];
    expect(agentConfig.connectionId).toBe("conn-ms-1");
    expect(agentConfig.permissions).toBeDefined();
    expect(agentConfig.accessToken).toBeUndefined();
    expect(agentConfig.refreshToken).toBeUndefined();
    expect(agentConfig.clientId).toBeUndefined();
    expect(agentConfig.clientSecret).toBeUndefined();
  });

  it("should NOT include pinchy-email when no email permissions exist", async () => {
    const agentsData = [
      {
        id: "plain-agent",
        name: "Plain Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["pinchy_ls"],
        createdAt: new Date(),
      },
    ];

    // Only Odoo permissions, no email
    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "plain-agent",
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
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

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

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    expect(config.plugins?.entries?.["pinchy-email"]).toBeUndefined();
  });

  it("should handle IMAP connection type for email", async () => {
    const agentsData = [
      {
        id: "imap-agent",
        name: "IMAP Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["email_list", "email_read", "email_search"],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "imap-agent",
          connectionId: "conn-imap-1",
          model: "email",
          operation: "read",
        },
        integration_connections: {
          id: "conn-imap-1",
          type: "imap",
          name: "Company IMAP",
          description: "",
          credentials: JSON.stringify({
            host: "mail.example.com",
            port: 993,
            user: "user@example.com",
            password: "secret-password",
          }),
          data: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      {
        agent_connection_permissions: {
          agentId: "imap-agent",
          connectionId: "conn-imap-1",
          model: "email",
          operation: "search",
        },
        integration_connections: {
          id: "conn-imap-1",
          type: "imap",
          name: "Company IMAP",
          description: "",
          credentials: JSON.stringify({
            host: "mail.example.com",
            port: 993,
            user: "user@example.com",
            password: "secret-password",
          }),
          data: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    ];

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

    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
      })
    );

    await regenerateOpenClawConfig();

    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    const config = JSON.parse(written);

    const emailPlugin = config.plugins?.entries?.["pinchy-email"];
    expect(emailPlugin).toBeDefined();
    expect(emailPlugin.enabled).toBe(true);

    const agentConfig = emailPlugin.config.agents["imap-agent"];
    expect(agentConfig.connectionId).toBe("conn-imap-1");
    expect(agentConfig.permissions).toEqual({ email: ["read", "search"] });

    // No credentials leaked
    expect(written).not.toContain("secret-password");
    expect(written).not.toContain("mail.example.com");
  });
});
