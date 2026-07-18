// Regression guard for the boot-OOM fan-out bug found on staging during
// v0.9.0 release verification.
//
// `regenerateOpenClawConfig` used to load agent connection permissions with
// `.innerJoin(integrationConnections, ...)` and NO column projection. That
// fans the full `integrationConnections.data` jsonb blob out across every
// permission row that references the connection. On staging, one Odoo
// connection carried an 837 kB `data` blob (the cached Odoo model catalog)
// and 426 permission rows pointed at it — the join transferred and
// materialized ~426 * 837 kB ~= 348 MB in the `allPermissions` array on
// every config regeneration, OOM-crashing the boot under the 1 GB container
// memory limit.
//
// `loadAgentConnectionPermissions` replaces the single fan-out join with two
// queries + in-memory reconstruction, so each connection (and its blob) is
// fetched exactly once and shared BY REFERENCE across every permission row
// that points at it. This test asserts that sharing directly: it is false
// under the old per-row join (each row gets its own connection object) and
// true after the fix.
import { describe, it, expect, vi } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: { ...actual },
  };
});

vi.mock("@/db", () => ({
  db: { select: vi.fn() },
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
  getDefaultModel: vi.fn().mockResolvedValue(""),
  fetchOllamaLocalModelsFromUrl: vi.fn().mockResolvedValue([]),
}));

import { loadAgentConnectionPermissions } from "@/lib/openclaw-config/build";
import { db } from "@/db";
import { agentConnectionPermissions, integrationConnections } from "@/db/schema";

type FakeDb = { select: ReturnType<typeof vi.fn> };

/**
 * Build a fake db whose `.from()` routes by table identity, mirroring the
 * real two-query shape `loadAgentConnectionPermissions` issues:
 *   - `db.select().from(agentConnectionPermissions)` — bare, resolves directly.
 *   - `db.select().from(integrationConnections).where(...)` — resolves via `.where()`.
 */
function fakeDb(permissionRows: unknown[], activeConnections: unknown[]): FakeDb {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === agentConnectionPermissions) {
          return Promise.resolve(permissionRows);
        }
        if (table === integrationConnections) {
          return { where: vi.fn().mockResolvedValue(activeConnections) };
        }
        throw new Error(`unexpected table passed to .from(): ${String(table)}`);
      }),
    })),
  };
}

describe("loadAgentConnectionPermissions (fan-out fix)", () => {
  it("materializes a connection with a large data blob exactly once and shares it by reference across every permission row", async () => {
    const bigBlob = {
      models: Array.from({ length: 500 }, (_, i) => ({ model: `model.${i}`, name: `Model ${i}` })),
    };
    const connection = {
      id: "conn-odoo-1",
      type: "odoo",
      name: "Big Odoo",
      status: "active",
      credentials: "{}",
      data: bigBlob,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const permissionRows = Array.from({ length: 50 }, (_, i) => ({
      agentId: `agent-${i}`,
      connectionId: "conn-odoo-1",
      model: "res.partner",
      operation: "read",
    }));

    const result = await loadAgentConnectionPermissions(
      fakeDb(permissionRows, [connection]) as unknown as typeof db
    );

    expect(result).toHaveLength(50);
    // The load-bearing assertion: every reconstructed row must point at the
    // SAME connection object. Under the old `.innerJoin()` fan-out, the DB
    // driver materializes a fresh row (and a fresh nested connection object)
    // per joined row, so this would be false; the fix fetches the connection
    // once and reuses the reference across all 50 rows.
    const [first, ...rest] = result;
    expect(first.integration_connections).toBe(connection);
    for (const row of rest) {
      expect(row.integration_connections).toBe(first.integration_connections);
    }
  });

  it("keeps inner-join semantics: excludes permissions whose connection is pending", async () => {
    const activeConn = { id: "conn-active", type: "odoo", status: "active" };
    // "conn-pending" is deliberately NOT included in activeConnections, since
    // the connections query filters `status != "pending"` at the DB level.
    const permissionRows = [
      { agentId: "a1", connectionId: "conn-active", model: "res.partner", operation: "read" },
      { agentId: "a2", connectionId: "conn-pending", model: "res.partner", operation: "read" },
    ];

    const result = await loadAgentConnectionPermissions(
      fakeDb(permissionRows, [activeConn]) as unknown as typeof db
    );

    expect(result).toHaveLength(1);
    expect(result[0].agent_connection_permissions.agentId).toBe("a1");
  });

  it("excludes permissions whose connection no longer exists", async () => {
    const permissionRows = [
      { agentId: "a1", connectionId: "conn-deleted", model: "res.partner", operation: "read" },
    ];

    const result = await loadAgentConnectionPermissions(
      fakeDb(permissionRows, []) as unknown as typeof db
    );

    expect(result).toHaveLength(0);
  });

  it("preserves permission-row iteration order across multiple connections", async () => {
    const connA = { id: "conn-a", type: "odoo", status: "active" };
    const connB = { id: "conn-b", type: "odoo", status: "active" };
    const permissionRows = [
      { agentId: "a1", connectionId: "conn-b", model: "m1", operation: "read" },
      { agentId: "a2", connectionId: "conn-a", model: "m2", operation: "read" },
    ];

    const result = await loadAgentConnectionPermissions(
      fakeDb(permissionRows, [connA, connB]) as unknown as typeof db
    );

    expect(result.map((r) => r.agent_connection_permissions.agentId)).toEqual(["a1", "a2"]);
    expect(result[0].integration_connections).toBe(connB);
    expect(result[1].integration_connections).toBe(connA);
  });
});
