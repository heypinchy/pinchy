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
import { db } from "@/db";
import { getSetting } from "@/lib/settings";

const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedDb = vi.mocked(db);
const mockedGetSetting = vi.mocked(getSetting);

// The regenerate writes more than one file (TOOLS.md mailbox context precedes
// the config write for email agents), so locate the openclaw.json write by
// path instead of assuming it is the first writeFileSync call.
function getWrittenConfigString(): string {
  const call = mockedWriteFileSync.mock.calls.find(
    (c) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
  );
  if (!call) throw new Error("openclaw.json was never written");
  return call[1] as string;
}

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

    const written = getWrittenConfigString();
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

    const written = getWrittenConfigString();
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

  it("grants email_search from the 'read' operation (the UI never writes a 'search' row)", async () => {
    // Real write-path shape: email-permission-section.tsx stores exactly
    // read/draft/send — search has no checkbox of its own; it is part of
    // "read" (EMAIL_READ_TOOLS in tool-registry.ts includes email_search, and
    // the pinchy-email plugin gates email_search behind the "read"
    // permission). The tools derivation must therefore include email_search
    // whenever read is granted; requiring a separate "search" row silently
    // strips search from every UI-configured agent.
    const agentsData = [
      {
        id: "email-agent",
        name: "Email Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["email_list", "email_read", "email_search", "email_draft"],
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
          credentials: JSON.stringify({ accessToken: "secret-token" }),
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
          credentials: JSON.stringify({ accessToken: "secret-token" }),
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

    const config = JSON.parse(getWrittenConfigString());
    const agentConfig = config.plugins.entries["pinchy-email"].config.agents["email-agent"];
    expect(agentConfig.tools).toContain("email_search");
    expect(agentConfig.tools).toEqual(
      expect.arrayContaining(["email_list", "email_read", "email_search", "email_draft"])
    );
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

    const written = getWrittenConfigString();

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

    const written = getWrittenConfigString();
    const config = JSON.parse(written);

    expect(config.plugins?.entries?.["pinchy-email"]).toBeUndefined();
  });

  it("should include pinchy-email plugin when agent has email permissions (type=imap)", async () => {
    // packages/plugins/pinchy-email/imap-adapter.ts now implements the full
    // EmailAdapter contract, and EMAIL_CONNECTION_TYPES (the shared list
    // build.ts's EMAIL_PROVIDER_TYPES is built from) includes "imap" — so an
    // imap-typed connection must flow through config emission exactly like
    // google/microsoft: provider-neutral connectionId + permissions (+
    // tools), never credentials. The plugin fetches credentials at runtime
    // via the internal API. This locks that behavior and guards against a
    // regression back to the old (pre-adapter) "imap is ignored" state.
    const agentsData = [
      {
        id: "imap-agent",
        name: "IMAP Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: ["email_list", "email_read", "email_search", "email_send"],
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
            imapHost: "mail.example.com",
            imapPort: 993,
            smtpHost: "smtp.example.com",
            smtpPort: 587,
            username: "user@example.com",
            password: "secret-password",
          }),
          data: { emailAddress: "user@example.com", provider: "imap" },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
      {
        agent_connection_permissions: {
          agentId: "imap-agent",
          connectionId: "conn-imap-1",
          model: "email",
          operation: "send",
        },
        integration_connections: {
          id: "conn-imap-1",
          type: "imap",
          name: "Company IMAP",
          description: "",
          credentials: JSON.stringify({
            imapHost: "mail.example.com",
            imapPort: 993,
            smtpHost: "smtp.example.com",
            smtpPort: 587,
            username: "user@example.com",
            password: "secret-password",
          }),
          data: { emailAddress: "user@example.com", provider: "imap" },
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

    const written = getWrittenConfigString();
    const config = JSON.parse(written);

    const emailPlugin = config.plugins?.entries?.["pinchy-email"];
    expect(emailPlugin).toBeDefined();
    expect(emailPlugin.enabled).toBe(true);

    const agentConfig = emailPlugin.config.agents["imap-agent"];
    expect(agentConfig.connectionId).toBe("conn-imap-1");
    expect(agentConfig.permissions).toEqual({ email: ["read", "send"] });

    // Provider-neutral emission only: connectionId + permissions + tools.
    // No imap-specific or credential fields on the agent config itself.
    expect(Object.keys(agentConfig).sort()).toEqual(["connectionId", "permissions", "tools"]);

    // CRUCIAL: the emitted pinchy-email entry must not carry the imap
    // credentials anywhere — the plugin fetches them at runtime via
    // GET /api/internal/integrations/:connectionId/credentials.
    const serializedEntry = JSON.stringify(emailPlugin);
    expect(serializedEntry).not.toContain("secret-password");
    expect(serializedEntry).not.toContain("mail.example.com");
    expect(serializedEntry).not.toContain("smtp.example.com");
    expect(serializedEntry).not.toContain("imapHost");
    expect(serializedEntry).not.toContain("password");

    // Belt-and-suspenders: not present anywhere in the whole serialized config.
    expect(written).not.toContain("secret-password");
  });

  // MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
  // pre-#328 agent template creation stored raw per-tool operations (list,
  // read, search, draft) directly as agent_connection_permissions rows (see
  // ebe6b47a2's "Operation vocabulary mismatch" fix, which corrected the
  // WRITE path via detectEmailOperations() but never touched rows that
  // already existed). A legacy agent can therefore have ONLY a (email,
  // "search") row in the DB, with no accompanying "read" row. Simulates that
  // exact pre-existing state (new code, old data) rather than starting from
  // a clean read+search write, per the sibling guard to the test-skip/
  // test-deletion policies.
  it("derives the read toolset and a legacy-tolerant permissions object for an agent whose ONLY DB row is legacy 'search' (no 'read' row)", async () => {
    const agentsData = [
      {
        id: "legacy-search-agent",
        name: "Legacy Search Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: [],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "legacy-search-agent",
          connectionId: "conn-google-legacy",
          model: "email",
          operation: "search",
        },
        integration_connections: {
          id: "conn-google-legacy",
          type: "google",
          name: "Legacy Gmail",
          description: "",
          credentials: JSON.stringify({ accessToken: "secret-token" }),
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

    const config = JSON.parse(getWrittenConfigString());
    const agentConfig = config.plugins.entries["pinchy-email"].config.agents["legacy-search-agent"];

    // The full read toolset must be emitted — a legacy search-only agent must
    // not silently lose email_list/email_read/email_search/email_get_attachment.
    expect(agentConfig.tools).toEqual(
      expect.arrayContaining(["email_list", "email_read", "email_search", "email_get_attachment"])
    );
    // Never additionally grants draft/send from a bare "search" row.
    expect(agentConfig.tools).not.toContain("email_draft");
    expect(agentConfig.tools).not.toContain("email_send");

    // The raw DB operation is passed through as-is (build.ts does not rewrite
    // the stored permission rows) — the plugin's checkPermission is the layer
    // that must tolerate this legacy shape (see permissions.ts).
    expect(agentConfig.permissions).toEqual({ email: ["search"] });
  });

  // MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
  // "list" is the OTHER legacy per-tool operation pre-#328 template creation
  // stored directly as agent_connection_permissions rows (see
  // ebe6b47a2's "Operation vocabulary mismatch" fix, which corrected the
  // WRITE path via detectEmailOperations() but never touched rows that
  // already existed). Unlike "search", "list" had NO alias at all until now —
  // a legacy agent whose ONLY DB row is (email, "list") derived an EMPTY
  // toolset AND a false "read" check, silently losing every email tool after
  // upgrading. Simulates that exact pre-existing state (new code, old data)
  // rather than starting from a clean read+list write, per the sibling guard
  // to the test-skip/test-deletion policies.
  it("derives the read toolset and a legacy-tolerant permissions object for an agent whose ONLY DB row is legacy 'list' (no 'read' row)", async () => {
    const agentsData = [
      {
        id: "legacy-list-agent",
        name: "Legacy List Agent",
        model: "anthropic/claude-haiku-4-5-20251001",
        allowedTools: [],
        createdAt: new Date(),
      },
    ];

    const permissionsData = [
      {
        agent_connection_permissions: {
          agentId: "legacy-list-agent",
          connectionId: "conn-google-legacy-list",
          model: "email",
          operation: "list",
        },
        integration_connections: {
          id: "conn-google-legacy-list",
          type: "google",
          name: "Legacy Gmail",
          description: "",
          credentials: JSON.stringify({ accessToken: "secret-token" }),
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

    const config = JSON.parse(getWrittenConfigString());
    const agentConfig = config.plugins.entries["pinchy-email"].config.agents["legacy-list-agent"];

    // The full read toolset must be emitted — a legacy list-only agent must
    // not silently lose email_list/email_read/email_search/email_get_attachment.
    expect(agentConfig.tools).toEqual(
      expect.arrayContaining(["email_list", "email_read", "email_search", "email_get_attachment"])
    );
    // Never additionally grants draft/send from a bare "list" row.
    expect(agentConfig.tools).not.toContain("email_draft");
    expect(agentConfig.tools).not.toContain("email_send");

    // The raw DB operation is passed through as-is (build.ts does not rewrite
    // the stored permission rows) — the plugin's checkPermission is the layer
    // that must tolerate this legacy shape (see permissions.ts).
    expect(agentConfig.permissions).toEqual({ email: ["list"] });
  });
});
