import { describe, it, expect, vi, beforeEach } from "vitest";

// TOOLS.md mailbox context generation during regenerateOpenClawConfig.
//
// The fs mock here is STATEFUL (fileStore): writes land in an in-memory map
// and reads consult it first. That is load-bearing for two scenarios:
//   - the ordering guarantee (R4): getAgentBootstrapSizes must see the
//     TOOLS.md written earlier in the SAME regeneration, and
//   - the stale-content transition (R2): a second regeneration against the
//     state the first one left behind — the "pre-existing data" test class
//     required by AGENTS.md ("Test Migrations Against Pre-Existing Data").

const { fileStore } = vi.hoisted(() => ({ fileStore: new Map<string, string>() }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const writeFileSyncMock = vi.fn((p: unknown, content: unknown) => {
    fileStore.set(String(p), String(content));
  });
  const readFileSyncMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(true);
  const mkdirSyncMock = vi.fn();
  const renameSyncMock = vi.fn((from: unknown, to: unknown) => {
    const content = fileStore.get(String(from));
    if (content !== undefined) fileStore.set(String(to), content);
    fileStore.delete(String(from));
  });
  const rmSyncMock = vi.fn((p: unknown) => {
    fileStore.delete(String(p));
  });
  const unlinkSyncMock = vi.fn((p: unknown) => {
    fileStore.delete(String(p));
  });
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
      rmSync: rmSyncMock,
      unlinkSync: unlinkSyncMock,
      chmodSync: chmodSyncMock,
    },
    writeFileSync: writeFileSyncMock,
    readFileSync: readFileSyncMock,
    existsSync: existsSyncMock,
    mkdirSync: mkdirSyncMock,
    renameSync: renameSyncMock,
    rmSync: rmSyncMock,
    unlinkSync: unlinkSyncMock,
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
  getDefaultModel: vi.fn(async () => "anthropic/claude-haiku-4-5-20251001"),
}));

import { readFileSync } from "fs";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import { generateToolsContent } from "@/lib/workspace";
import {
  OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS,
  BOOTSTRAP_HEADROOM_CHARS,
} from "@/lib/openclaw-config/bootstrap-caps";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedDb = vi.mocked(db);

const CONFIG_PATH = "/openclaw-config/openclaw.json";
const gatewayConfig = {
  gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
};

function toolsMdPath(agentId: string): string {
  return `/openclaw-config/workspaces/${agentId}/TOOLS.md`;
}

function getWrittenConfig(): Record<string, unknown> & {
  agents: { list: Array<Record<string, unknown>> };
  plugins?: { entries?: Record<string, { config: Record<string, unknown> }> };
} {
  const written = fileStore.get(CONFIG_PATH);
  if (!written) throw new Error("openclaw.json was never written");
  return JSON.parse(written);
}

interface PermissionRow {
  agent_connection_permissions: {
    agentId: string;
    connectionId: string;
    model: string;
    operation: string;
  };
  integration_connections: Record<string, unknown>;
}

function emailConnection(
  id: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    id,
    type: "microsoft",
    name: `Mailbox ${id}`,
    description: "",
    credentials: "{}",
    data: { emailAddress: `${id}@example.com`, provider: "microsoft" },
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function emailPermission(
  agentId: string,
  connection: Record<string, unknown>,
  operation: string
): PermissionRow {
  return {
    agent_connection_permissions: {
      agentId,
      connectionId: connection.id as string,
      model: "email",
      operation,
    },
    integration_connections: connection,
  };
}

/**
 * Wire the db mock: plain from() → agents, from().innerJoin().where() →
 * permission rows, from().where() → web-search connections.
 */
function mockDb(
  agentsData: Array<Record<string, unknown>>,
  permissionsData: PermissionRow[],
  webSearchConnections: Array<Record<string, unknown>> = []
) {
  mockedDb.select.mockReturnValue({
    from: vi.fn().mockImplementation(() =>
      Object.assign(Promise.resolve(agentsData), {
        innerJoin: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve(permissionsData), {
            where: vi.fn().mockResolvedValue(permissionsData),
          })
        ),
        where: vi.fn().mockResolvedValue(webSearchConnections),
      })
    ),
  } as never);
}

function agentRow(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    model: "anthropic/claude-haiku-4-5-20251001",
    allowedTools: [],
    pluginConfig: null,
    ownerId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("regenerateOpenClawConfig TOOLS.md mailbox context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileStore.clear();
    // Reads: workspace/bootstrap files come from the stateful store; the
    // openclaw.json cold-start read falls back to a minimal gateway config;
    // everything else is ENOENT (missing bootstrap files are skipped).
    mockedReadFileSync.mockImplementation((p) => {
      const path = String(p);
      const stored = fileStore.get(path);
      if (stored !== undefined) return stored;
      if (path.endsWith("openclaw.json")) return JSON.stringify(gatewayConfig);
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    });
  });

  it("writes TOOLS.md with the connected mailbox address, label, and granted operations", async () => {
    const conn = emailConnection("conn-ms-1", { name: "Support Inbox" });
    mockDb(
      [agentRow("hermes")],
      [
        emailPermission("hermes", conn, "read"),
        emailPermission("hermes", conn, "search"),
        emailPermission("hermes", conn, "send"),
      ]
    );

    await regenerateOpenClawConfig();

    const toolsMd = fileStore.get(toolsMdPath("hermes"));
    expect(toolsMd).toBeDefined();
    expect(toolsMd).toContain("## Connected Email");
    expect(toolsMd).toContain("conn-ms-1@example.com");
    expect(toolsMd).toContain("Support Inbox");
    expect(toolsMd).toContain("read messages");
    expect(toolsMd).toContain("send email");
    // The mailbox identity disclaimer (shared agents serve multiple users).
    expect(toolsMd).toContain("not necessarily the personal address of the user");
  });

  it("falls back to the connection name when data.emailAddress is absent", async () => {
    const conn = emailConnection("conn-noaddr", { name: "Legacy Mailbox", data: null });
    mockDb([agentRow("hermes")], [emailPermission("hermes", conn, "read")]);

    await regenerateOpenClawConfig();

    const toolsMd = fileStore.get(toolsMdPath("hermes"));
    expect(toolsMd).toContain("### Legacy Mailbox");
  });

  it("removes a previously generated TOOLS.md when email permissions are revoked (pre-existing data transition)", async () => {
    const conn = emailConnection("conn-old", { name: "Old Mailbox" });
    mockDb([agentRow("hermes")], [emailPermission("hermes", conn, "read")]);
    await regenerateOpenClawConfig();
    expect(fileStore.get(toolsMdPath("hermes"))).toContain("conn-old@example.com");

    // Permissions removed in the DB; the workspace still carries the old
    // TOOLS.md from the previous regeneration (pre-existing state).
    mockDb([agentRow("hermes")], []);
    await regenerateOpenClawConfig();

    expect(fileStore.has(toolsMdPath("hermes"))).toBe(false);
    // Nothing on disk mentions the revoked mailbox any more.
    for (const [, content] of fileStore) {
      expect(content).not.toContain("conn-old@example.com");
    }
  });

  it("sizes bootstrap caps from the TOOLS.md written in the SAME regeneration (ordering)", async () => {
    // A TOOLS.md larger than OpenClaw's 12k default per-file cap. If the file
    // were written AFTER getAgentBootstrapSizes ran, the caps would lag one
    // regeneration behind and this (first) regen would emit no caps at all.
    const hugeLabel = "L".repeat(15_000);
    const conn = emailConnection("conn-big", { name: hugeLabel });
    mockDb([agentRow("big-email-agent")], [emailPermission("big-email-agent", conn, "read")]);

    await regenerateOpenClawConfig();

    const expectedToolsMd = generateToolsContent([
      { address: "conn-big@example.com", label: hugeLabel, operations: ["read"] },
    ]);
    expect(fileStore.get(toolsMdPath("big-email-agent"))).toBe(expectedToolsMd);

    const config = getWrittenConfig();
    const entry = config.agents.list.find((a) => a.id === "big-email-agent");
    expect(entry?.bootstrapMaxChars).toBe(
      expectedToolsMd.trimEnd().length + BOOTSTRAP_HEADROOM_CHARS
    );
    expect(entry?.bootstrapMaxChars as number).toBeGreaterThan(
      OPENCLAW_DEFAULT_BOOTSTRAP_MAX_CHARS
    );
  });

  it("keeps Odoo and web plugin configs untouched for an agent with email + Odoo + web (multi-integration safety)", async () => {
    const emailConn = emailConnection("conn-mail", { name: "Multi Mailbox" });
    const odooConn = {
      id: "conn-odoo-1",
      type: "odoo",
      name: "Odoo Prod",
      description: "",
      credentials: "{}",
      data: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const webConn = {
      id: "conn-web-1",
      type: "web-search",
      name: "Brave Search",
      description: "",
      credentials: "{}",
      data: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockDb(
      [agentRow("multi", { allowedTools: ["pinchy_web_search", "email_read"] })],
      [
        emailPermission("multi", emailConn, "read"),
        {
          agent_connection_permissions: {
            agentId: "multi",
            connectionId: "conn-odoo-1",
            model: "res.partner",
            operation: "read",
          },
          integration_connections: odooConn,
        },
      ],
      [webConn]
    );

    await regenerateOpenClawConfig();

    // TOOLS.md lists only the email mailbox — no Odoo/web leakage.
    const toolsMd = fileStore.get(toolsMdPath("multi"))!;
    expect(toolsMd).toContain("conn-mail@example.com");
    expect(toolsMd).not.toContain("Odoo");
    expect(toolsMd).not.toContain("Brave");

    // The Odoo and web plugin configs are exactly what the pre-TOOLS.md
    // pipeline emitted — the mailbox context feature must not interfere.
    const config = getWrittenConfig();
    expect(config.plugins?.entries?.["pinchy-odoo"]?.config.agents).toEqual({
      multi: {
        connectionId: "conn-odoo-1",
        permissions: { "res.partner": ["read"] },
        modelNames: {},
      },
    });
    expect(config.plugins?.entries?.["pinchy-web"]?.config.agents).toEqual({
      multi: { tools: ["pinchy_web_search"] },
    });
    expect(config.plugins?.entries?.["pinchy-web"]?.config.connectionId).toBe("conn-web-1");
    expect(config.plugins?.entries?.["pinchy-email"]?.config.agents).toEqual({
      multi: {
        connectionId: "conn-mail",
        permissions: { email: ["read"] },
        tools: ["email_list", "email_read"],
      },
    });
  });

  it("lists exactly the connection the plugin serves when an agent has multiple email connections, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connA = emailConnection("conn-alpha", { name: "Alpha Mailbox" });
    const connB = emailConnection("conn-beta", { name: "Beta Mailbox" });
    mockDb(
      [agentRow("dual", { name: "Dual Mailbox Agent" })],
      [emailPermission("dual", connA, "read"), emailPermission("dual", connB, "send")]
    );

    await regenerateOpenClawConfig();

    // The runtime serves the FIRST connection (first-wins connectionId with
    // ops merged across all connections). TOOLS.md must mirror exactly that —
    // context and runtime can never diverge.
    const config = getWrittenConfig();
    const emailAgentConfig = config.plugins?.entries?.["pinchy-email"]?.config.agents as Record<
      string,
      { connectionId: string; tools: string[] }
    >;
    expect(emailAgentConfig.dual.connectionId).toBe("conn-alpha");
    expect(emailAgentConfig.dual.tools).toContain("email_send");

    const toolsMd = fileStore.get(toolsMdPath("dual"))!;
    expect(toolsMd).toContain("conn-alpha@example.com");
    expect(toolsMd).not.toContain("conn-beta@example.com");
    // Merged ops are what the runtime actually grants — TOOLS.md says so too.
    expect(toolsMd).toContain("send email");

    // The silent first-wins pick is surfaced to operators, naming the agent.
    const multiConnWarning = warn.mock.calls.find((c) =>
      String(c[0]).includes("Dual Mailbox Agent")
    );
    expect(multiConnWarning).toBeDefined();
    expect(String(multiConnWarning![0])).toContain("email connections");
    warn.mockRestore();
  });

  it("regenerates cleanly for an agent with no integrations at all (no TOOLS.md, no crash)", async () => {
    mockDb([agentRow("plain")], []);

    await regenerateOpenClawConfig();

    expect(fileStore.has(toolsMdPath("plain"))).toBe(false);
    const config = getWrittenConfig();
    expect(config.plugins?.entries?.["pinchy-email"]).toBeUndefined();
    expect(config.agents.list.find((a) => a.id === "plain")).toBeDefined();
  });
});
