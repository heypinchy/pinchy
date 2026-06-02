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

import { db } from "@/db";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { setIntegrationAuthFailed, clearIntegrationAuthError } from "@/lib/integrations/auth-state";

const mockedDb = vi.mocked(db);
const mockedAppendAudit = vi.mocked(appendAuditLog);
const mockedRecordAuditFailure = vi.mocked(recordAuditFailure);

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
