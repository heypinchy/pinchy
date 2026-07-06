import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─────────────────────────────────────────────────────────────────────────
// MIGRATION TEST (AGENTS.md § "Test Migrations Against Pre-Existing Data")
//
// IMAP is a NEW connection `type` this feature introduces. Every unit test
// elsewhere in the suite creates its imap fixtures fresh, in-process, inside
// the same test that reads them back — which proves nothing about a REAL
// upgrade: a `type: "imap"` row that was written to `integration_connections`
// (and a matching `agent_connection_permissions` row) by an OLDER deploy,
// then read by the CURRENT code after a deploy that adds new readers.
//
// This file seeds exactly that pre-existing row ONCE (as plain data below,
// never through POST /api/integrations/imap in-process), and then asserts
// the cross-route "listed ⟹ readable" invariant against THREE independent
// readers that a real upgrade must not break:
//
//   1. GET /api/integrations             — the connection is LISTED (settings UI)
//   2. GET /api/internal/.../credentials — the connection is READABLE (detail)
//   3. regenerateOpenClawConfig()        — the connection is USABLE at runtime
//      (the plugin config the OpenClaw gateway actually loads)
//
// Each section below dynamically imports the real route handler / config
// builder under its own vi.doMock wiring (reset via vi.resetModules()
// between sections) so all three exercise actual production code paths
// rather than a re-implementation, while still sharing the SAME seeded
// pre-existing row and permission grant defined once at the top.
//
// If a connection is listed but any of these break, an admin sees the
// integration in settings while the agent silently can't use it — exactly
// the failure mode the "listed implies readable" cross-route invariant
// guards against.
// ─────────────────────────────────────────────────────────────────────────

const PRE_EXISTING_CONNECTION_ID = "conn-imap-preexisting";
const PRE_EXISTING_AGENT_ID = "agent-imap-preexisting";

// The exact IMAP credential shape imap/route.ts encrypts and stores today.
const preExistingImapCredentials = {
  imapHost: "imap.pre-existing.example.com",
  imapPort: 993,
  smtpHost: "smtp.pre-existing.example.com",
  smtpPort: 587,
  username: "mailbox@pre-existing.example.com",
  password: "pre-existing-app-password",
  security: "tls",
};

// A minimal, reversible fake so encrypt(decrypt(x)) round-trips without
// touching the real filesystem-backed secret (see @/lib/encryption).
function fakeEncrypt(plaintext: string): string {
  return `enc:${plaintext}`;
}
function fakeDecrypt(ciphertext: string): string {
  return ciphertext.replace(/^enc:/, "");
}

// The pre-existing DB row exactly as it would have been written by the
// create route: type "imap", status "active", encrypted credentials blob,
// and `data: { emailAddress, provider: "imap" }`.
const preExistingConnectionRow = {
  id: PRE_EXISTING_CONNECTION_ID,
  type: "imap",
  name: "Pre-existing Company IMAP",
  description: "",
  credentials: fakeEncrypt(JSON.stringify(preExistingImapCredentials)),
  data: { emailAddress: preExistingImapCredentials.username, provider: "imap" },
  status: "active",
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// Matching pre-existing permission grant: the agent already had email
// read + send permissions on this connection before the upgrade.
const preExistingPermissionRows = [
  {
    agent_connection_permissions: {
      agentId: PRE_EXISTING_AGENT_ID,
      connectionId: PRE_EXISTING_CONNECTION_ID,
      model: "email",
      operation: "read",
    },
    integration_connections: {
      id: PRE_EXISTING_CONNECTION_ID,
      type: "imap",
      name: preExistingConnectionRow.name,
      description: "",
      credentials: preExistingConnectionRow.credentials,
      data: preExistingConnectionRow.data,
      createdAt: preExistingConnectionRow.createdAt,
      updatedAt: preExistingConnectionRow.updatedAt,
    },
  },
  {
    agent_connection_permissions: {
      agentId: PRE_EXISTING_AGENT_ID,
      connectionId: PRE_EXISTING_CONNECTION_ID,
      model: "email",
      operation: "send",
    },
    integration_connections: {
      id: PRE_EXISTING_CONNECTION_ID,
      type: "imap",
      name: preExistingConnectionRow.name,
      description: "",
      credentials: preExistingConnectionRow.credentials,
      data: preExistingConnectionRow.data,
      createdAt: preExistingConnectionRow.createdAt,
      updatedAt: preExistingConnectionRow.updatedAt,
    },
  },
];

describe("Pre-existing IMAP connection — cross-route invariant (listed ⟹ readable)", () => {
  describe("1. Listed — GET /api/integrations returns the pre-existing imap connection", () => {
    beforeEach(() => {
      vi.resetModules();

      const mockGetSession = vi.fn().mockResolvedValue({
        user: { id: "admin-1", email: "admin@test.com", role: "admin" },
      });

      vi.doMock("next/headers", () => ({
        headers: vi.fn().mockResolvedValue(new Headers()),
      }));
      vi.doMock("@/lib/auth", () => ({
        getSession: (...args: unknown[]) => mockGetSession(...args),
        auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
      }));
      vi.doMock("@/lib/encryption", () => ({
        encrypt: fakeEncrypt,
        decrypt: fakeDecrypt,
        getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
      }));
      vi.doMock("@/db", () => ({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockResolvedValue([preExistingConnectionRow]),
          }),
        },
      }));
    });

    it("returns the imap connection's id/name/type/status in the settings list", async () => {
      // This exercises the REAL GET handler — no re-implementation of the
      // list logic here. The row was never written via POST; it only ever
      // existed as pre-seeded data, exactly as a pre-upgrade row would.
      const { GET } = await import("@/app/api/integrations/route");

      const response = await GET();
      expect(response.status).toBe(200);

      const body = (await response.json()) as Array<{
        id: string;
        name: string;
        type: string;
        status: string;
      }>;

      const listed = body.find((c) => c.id === PRE_EXISTING_CONNECTION_ID);
      expect(listed).toBeDefined();
      expect(listed).toMatchObject({
        id: PRE_EXISTING_CONNECTION_ID,
        name: "Pre-existing Company IMAP",
        type: "imap",
        status: "active",
      });
    });
  });

  describe("2. Credentials readable — GET /api/internal/integrations/:id/credentials", () => {
    beforeEach(() => {
      vi.resetModules();

      vi.doMock("@/lib/encryption", () => ({
        encrypt: fakeEncrypt,
        decrypt: fakeDecrypt,
        getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
      }));
      vi.doMock("@/lib/gateway-auth", () => ({
        validateGatewayToken: vi.fn().mockReturnValue(true),
      }));
      vi.doMock("@/db", () => ({
        db: {
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([preExistingConnectionRow]),
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        },
      }));
      vi.doMock("@/lib/integrations/google-oauth", () => ({
        refreshAccessToken: vi.fn(),
      }));
      vi.doMock("@/lib/integrations/microsoft-oauth", () => ({
        refreshAccessToken: vi.fn(),
      }));
      vi.doMock("@/lib/integrations/oauth-settings", () => ({
        getOAuthSettings: vi.fn().mockResolvedValue(null),
      }));
    });

    function makeRequest(connectionId: string) {
      return new NextRequest(
        `http://localhost/api/internal/integrations/${connectionId}/credentials`,
        { method: "GET", headers: { Authorization: "Bearer test-gateway-token" } }
      );
    }
    function makeParams(connectionId: string) {
      return { params: Promise.resolve({ connectionId }) };
    }

    it("decrypts and returns the full IMAP credential shape for the pre-existing row", async () => {
      // Real route handler, real (fake-encrypted) decrypt round trip — this
      // is the "detail" reader: an agent's plugin fetches this exact
      // endpoint at runtime using the gateway token as bearer auth.
      const { GET } =
        await import("@/app/api/internal/integrations/[connectionId]/credentials/route");
      const { getOAuthSettings } = await import("@/lib/integrations/oauth-settings");

      const res = await GET(
        makeRequest(PRE_EXISTING_CONNECTION_ID),
        makeParams(PRE_EXISTING_CONNECTION_ID)
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.type).toBe("imap");
      expect(data.credentials).toEqual(preExistingImapCredentials);

      // imap has no OAuth dispatch entry — pin that the pre-existing row
      // never routes through the refresh/OAuth-settings machinery.
      expect(getOAuthSettings).not.toHaveBeenCalled();
    });
  });

  describe("3. Config emitted — regenerateOpenClawConfig() includes the granting agent", () => {
    beforeEach(() => {
      vi.resetModules();

      vi.doMock("fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("fs")>();
        const writeFileSyncMock = vi.fn();
        const readFileSyncMock = vi.fn().mockReturnValue(
          JSON.stringify({
            gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
          })
        );
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

      vi.doMock("@/lib/encryption", () => ({
        encrypt: fakeEncrypt,
        decrypt: fakeDecrypt,
        getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
      }));
      vi.doMock("@/lib/settings", () => ({
        getSetting: vi.fn().mockResolvedValue(null),
        setSetting: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock("@/server/restart-state", () => ({
        restartState: { notifyRestart: vi.fn() },
      }));
      vi.doMock("@/lib/migrate-onboarding", () => ({
        migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock("@/lib/openclaw-secrets", async (importOriginal) => {
        const actual = await importOriginal<typeof import("@/lib/openclaw-secrets")>();
        return {
          ...actual,
          writeSecretsFile: vi.fn(),
          readSecretsFile: vi.fn().mockReturnValue({}),
        };
      });
      vi.doMock("@/lib/provider-models", () => ({
        getDefaultModel: vi.fn(async (provider: string) =>
          provider === "anthropic" ? "anthropic/claude-haiku-4-5-20251001" : ""
        ),
      }));

      const agentsData = [
        {
          id: PRE_EXISTING_AGENT_ID,
          name: "Pre-existing IMAP Agent",
          model: "anthropic/claude-haiku-4-5-20251001",
          allowedTools: ["email_list", "email_read", "email_search", "email_send"],
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ];

      vi.doMock("@/db", () => ({
        db: {
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockImplementation(() =>
              Object.assign(Promise.resolve(agentsData), {
                innerJoin: vi.fn().mockReturnValue(
                  Object.assign(Promise.resolve(preExistingPermissionRows), {
                    where: vi.fn().mockResolvedValue(preExistingPermissionRows),
                  })
                ),
                where: vi.fn().mockResolvedValue([]),
              })
            ),
          })),
        },
      }));
    });

    function getWrittenConfigString(writeFileSyncMock: ReturnType<typeof vi.fn>): string {
      const call = writeFileSyncMock.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("openclaw.json")
      );
      if (!call) throw new Error("openclaw.json was never written");
      return call[1] as string;
    }

    it("emits a pinchy-email entry for the pre-existing agent+connection+permissions, with no credentials leaked", async () => {
      // Real config builder — no re-implementation. Proves the connection
      // (and the permission rows granting it) that only ever existed as
      // pre-seeded data is fully wired into what OpenClaw actually loads at
      // runtime, i.e. the plugin can fetch credentials for this
      // connectionId and knows which operations the agent may perform.
      const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");
      const { writeFileSync } = await import("fs");
      const writeFileSyncMock = vi.mocked(writeFileSync);

      await regenerateOpenClawConfig();

      const written = getWrittenConfigString(writeFileSyncMock);
      const config = JSON.parse(written);

      const emailPlugin = config.plugins?.entries?.["pinchy-email"];
      expect(emailPlugin).toBeDefined();
      expect(emailPlugin.enabled).toBe(true);

      const agentConfig = emailPlugin.config.agents[PRE_EXISTING_AGENT_ID];
      expect(agentConfig.connectionId).toBe(PRE_EXISTING_CONNECTION_ID);
      expect(agentConfig.permissions).toEqual({ email: ["read", "send"] });

      // Never emits imap credentials into the config the gateway loads —
      // the plugin fetches them at runtime via the internal credentials route.
      expect(written).not.toContain("pre-existing-app-password");
      expect(written).not.toContain("imap.pre-existing.example.com");
      expect(written).not.toContain("smtp.pre-existing.example.com");
    });
  });
});
