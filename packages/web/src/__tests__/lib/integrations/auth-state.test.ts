import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => ({
  db: {
    update: vi.fn(),
    select: vi.fn(),
  },
}));
vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn(),
}));
vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: vi.fn(),
}));
vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/db";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { setIntegrationAuthFailed, clearIntegrationAuthError } from "@/lib/integrations/auth-state";

const mockedDb = vi.mocked(db);
const mockedAppendAudit = vi.mocked(appendAuditLog);
const mockedRecordAuditFailure = vi.mocked(recordAuditFailure);
const mockedRegenerate = vi.mocked(regenerateOpenClawConfig);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setIntegrationAuthFailed", () => {
  it("writes status=auth_failed + lastError + lastErrorAt + audit when status was active", async () => {
    const fakeUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "c1", name: "Odoo", status: "active" }]),
    };
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "active" }]),
      }),
    } as never);
    mockedDb.update.mockReturnValue(fakeUpdate as never);

    await setIntegrationAuthFailed({
      connectionId: "c1",
      reason: "401 from Odoo",
      actor: { type: "system", id: "plugin:pinchy-odoo" },
    });

    expect(fakeUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "auth_failed",
        lastError: "401 from Odoo",
      })
    );
    expect(mockedAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.auth_failed",
        resource: "integration:c1",
        outcome: "success",
        detail: { id: "c1", name: "Odoo", reason: "401 from Odoo" },
      })
    );
  });

  it("is idempotent: does NOT write a second audit entry when status is already auth_failed", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "auth_failed" }]),
      }),
    } as never);
    // The conditional UPDATE excludes rows already in auth_failed state, so
    // RETURNING comes back empty — the idempotent path.
    const fakeUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    mockedDb.update.mockReturnValue(fakeUpdate as never);

    await setIntegrationAuthFailed({
      connectionId: "c1",
      reason: "401 from Odoo (again)",
      actor: { type: "system", id: "plugin:pinchy-odoo" },
    });

    expect(fakeUpdate.set).toHaveBeenCalled();
    expect(mockedAppendAudit).not.toHaveBeenCalled();
  });

  it("returns silently when connection does not exist (no throw, no audit)", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([]) }),
    } as never);

    await setIntegrationAuthFailed({
      connectionId: "ghost",
      reason: "401",
      actor: { type: "system", id: "plugin:x" },
    });

    expect(mockedDb.update).not.toHaveBeenCalled();
    expect(mockedAppendAudit).not.toHaveBeenCalled();
  });

  it("does NOT emit a duplicate audit when a concurrent caller already transitioned (conditional UPDATE returns 0 rows)", async () => {
    // Race scenario: two callers both see status='active' on their SELECT
    // (e.g. sync route + plugin report-auth-failure firing simultaneously).
    // Without an atomic conditional UPDATE, both would write the same audit
    // transition. We guard against this by guarding the UPDATE on the prior
    // status and emitting audit only when RETURNING confirms WE flipped it.
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "active" }]),
      }),
    } as never);
    // The UPDATE … WHERE status != 'auth_failed' affects zero rows because
    // the other caller already flipped it between our SELECT and UPDATE.
    const fakeUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    mockedDb.update.mockReturnValue(fakeUpdate as never);

    await setIntegrationAuthFailed({
      connectionId: "c1",
      reason: "401 from Odoo",
      actor: { type: "system", id: "plugin:pinchy-odoo" },
    });

    expect(fakeUpdate.set).toHaveBeenCalled();
    // Critical: no audit row for a transition we did not perform.
    expect(mockedAppendAudit).not.toHaveBeenCalled();
  });
});

describe("clearIntegrationAuthError", () => {
  it("only writes audit + clears when prior status was auth_failed", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "auth_failed" }]),
      }),
    } as never);
    const fakeUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "c1", name: "Odoo" }]),
    };
    mockedDb.update.mockReturnValue(fakeUpdate as never);

    await clearIntegrationAuthError({
      connectionId: "c1",
      actor: { type: "user", id: "u1" },
    });

    expect(fakeUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active", lastError: null, lastErrorAt: null })
    );
    expect(mockedAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.auth_recovered",
        resource: "integration:c1",
        outcome: "success",
      })
    );
  });

  it("does nothing when prior status was already active", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "active" }]),
      }),
    } as never);

    await clearIntegrationAuthError({
      connectionId: "c1",
      actor: { type: "user", id: "u1" },
    });

    expect(mockedDb.update).not.toHaveBeenCalled();
    expect(mockedAppendAudit).not.toHaveBeenCalled();
  });

  it("returns silently when connection does not exist (no throw, no audit)", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([]) }),
    } as never);

    await clearIntegrationAuthError({
      connectionId: "ghost",
      actor: { type: "user", id: "u1" },
    });

    expect(mockedDb.update).not.toHaveBeenCalled();
    expect(mockedAppendAudit).not.toHaveBeenCalled();
  });

  it("does NOT emit a duplicate audit when a concurrent caller already recovered (conditional UPDATE returns 0 rows)", async () => {
    // Same race shape as setIntegrationAuthFailed: two callers see
    // status='auth_failed' simultaneously (e.g. successful Test + successful
    // Sync within milliseconds), both want to flip back to 'active'. Audit
    // must fire exactly once — the caller that wins the conditional UPDATE.
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "auth_failed" }]),
      }),
    } as never);
    const fakeUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    mockedDb.update.mockReturnValue(fakeUpdate as never);

    await clearIntegrationAuthError({
      connectionId: "c1",
      actor: { type: "user", id: "u1" },
    });

    expect(fakeUpdate.set).toHaveBeenCalled();
    expect(mockedAppendAudit).not.toHaveBeenCalled();
  });
});

describe("audit failure handling", () => {
  it("calls recordAuditFailure when appendAuditLog throws during auth_failed transition", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "active" }]),
      }),
    } as never);
    const fakeUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "c1" }]),
    };
    mockedDb.update.mockReturnValue(fakeUpdate as never);
    mockedAppendAudit.mockRejectedValueOnce(new Error("DB write failed"));

    await setIntegrationAuthFailed({
      connectionId: "c1",
      reason: "401",
      actor: { type: "system", id: "plugin:x" },
    });

    expect(mockedRecordAuditFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ eventType: "integration.auth_failed" })
    );
  });

  it("calls recordAuditFailure when appendAuditLog throws during recovery", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "c1", name: "Odoo", status: "auth_failed" }]),
      }),
    } as never);
    const fakeUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "c1" }]),
    };
    mockedDb.update.mockReturnValue(fakeUpdate as never);
    mockedAppendAudit.mockRejectedValueOnce(new Error("DB write failed"));

    await clearIntegrationAuthError({
      connectionId: "c1",
      actor: { type: "user", id: "u1" },
    });

    expect(mockedRecordAuditFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ eventType: "integration.auth_recovered" })
    );
  });
});

/**
 * MCP config regeneration on auth-status transitions.
 *
 * MCP's per-agent gating lives in openclaw.json itself (build.ts emits
 * `mcp.servers` + `tools.allow` only for connections with status "active"), so
 * "status changed" implies "config is stale" — for MCP and only for MCP. That
 * invariant lives here, at the single place status actually changes, rather
 * than at each of the four callers that can trigger a transition (sync route,
 * Test Connection ×3): all four were originally missed, and a fail-closed path
 * must not depend on every future caller remembering.
 *
 * Being inside the transition guard is also what makes it precise — the
 * callers cannot distinguish a real flip from a no-op (both functions return
 * void and bail early when the conditional UPDATE matches no rows), so a
 * caller-side trigger necessarily regenerates on repeat calls too.
 */
describe("MCP config regeneration on auth transitions", () => {
  function mockConnection(row: Record<string, unknown>, transitioned: boolean) {
    mockedDb.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([row]) }),
    } as never);
    mockedDb.update.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue(transitioned ? [{ id: row.id }] : []),
    } as never);
  }

  const mcpActive = { id: "c-mcp", name: "GitHub MCP", type: "mcp", status: "active" };
  const mcpFailed = { id: "c-mcp", name: "GitHub MCP", type: "mcp", status: "auth_failed" };

  it("regenerates when an MCP connection really flips active → auth_failed", async () => {
    mockConnection(mcpActive, true);

    await setIntegrationAuthFailed({
      connectionId: "c-mcp",
      reason: "token expired",
      actor: { type: "user", id: "u1" },
    });

    // Without this the config keeps a live mcp.servers entry for a connection
    // that can no longer authenticate: OpenClaw retries the failing
    // initialize handshake on every reload, and the config claims a
    // reachability that no longer exists.
    expect(mockedRegenerate).toHaveBeenCalledTimes(1);
  });

  it("regenerates when an MCP connection really recovers auth_failed → active", async () => {
    mockConnection(mcpFailed, true);

    await clearIntegrationAuthError({ connectionId: "c-mcp", actor: { type: "user", id: "u1" } });

    // The mirror case: until this runs, build.ts still filters the connection
    // out, so the agent's existing grants stay fail-closed even though the UI
    // reports the connection healthy again.
    expect(mockedRegenerate).toHaveBeenCalledTimes(1);
  });

  it("does NOT regenerate on a no-op setIntegrationAuthFailed (already auth_failed)", async () => {
    // The whole point of living behind the transition guard: repeatedly
    // hitting "Test Connection" on an already-failed MCP connection changes
    // nothing, so it must not kick off a full config regenerate each time.
    mockConnection(mcpFailed, false);

    await setIntegrationAuthFailed({
      connectionId: "c-mcp",
      reason: "token expired (again)",
      actor: { type: "user", id: "u1" },
    });

    expect(mockedAppendAudit).not.toHaveBeenCalled();
    expect(mockedRegenerate).not.toHaveBeenCalled();
  });

  it("does NOT regenerate on a no-op clearIntegrationAuthError (already active)", async () => {
    mockConnection(mcpActive, false);

    await clearIntegrationAuthError({ connectionId: "c-mcp", actor: { type: "user", id: "u1" } });

    expect(mockedAppendAudit).not.toHaveBeenCalled();
    expect(mockedRegenerate).not.toHaveBeenCalled();
  });

  it("does NOT regenerate when the connection does not exist", async () => {
    mockedDb.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([]) }),
    } as never);

    await setIntegrationAuthFailed({
      connectionId: "ghost",
      reason: "401",
      actor: { type: "system", id: "plugin:x" },
    });

    expect(mockedRegenerate).not.toHaveBeenCalled();
  });

  it.each([["odoo"], ["imap"], ["google"], ["microsoft"], ["web-search"]])(
    "does NOT regenerate for a non-MCP type (%s) — those gate at runtime in their plugin",
    async (type) => {
      // The promise that existing integration types stay byte-identical:
      // their status never reaches openclaw.json (the plugin fetches
      // credentials and checks permissions at tool-call time), so a
      // transition here has no config consequence at all.
      mockConnection({ id: "c1", name: "Conn", type, status: "active" }, true);

      await setIntegrationAuthFailed({
        connectionId: "c1",
        reason: "401",
        actor: { type: "system", id: "plugin:x" },
      });

      expect(mockedAppendAudit).toHaveBeenCalled(); // the transition DID happen
      expect(mockedRegenerate).not.toHaveBeenCalled(); // …it just isn't config-relevant
    }
  );

  it("contains a regenerate failure: the committed status change must not throw or roll back", async () => {
    // Regression guard (moved here with the trigger). The status change has
    // already committed, so a failed config write must not surface as a
    // failure of the thing that succeeded. This is not cosmetic: the Test
    // Connection route's catch-all turns ANY throw into
    // setIntegrationAuthFailed(reason: <error>), so a propagating regen throw
    // on the recovery path would mark a *healthy* MCP connection auth_failed
    // purely because openclaw.json couldn't be written.
    mockConnection(mcpFailed, true);
    mockedRegenerate.mockRejectedValueOnce(new Error("EACCES: openclaw.json"));

    await expect(
      clearIntegrationAuthError({ connectionId: "c-mcp", actor: { type: "user", id: "u1" } })
    ).resolves.toBeUndefined();

    // The recovery itself still stands and is still audited.
    expect(mockedAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "integration.auth_recovered" })
    );
  });
});
