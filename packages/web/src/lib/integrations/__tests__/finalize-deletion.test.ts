import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockRegen, mockDeleteOAuth, mockAudit } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  mockRegen: vi.fn().mockResolvedValue(undefined),
  mockDeleteOAuth: vi.fn().mockResolvedValue(undefined),
  mockAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db", () => ({ db: mockDb }));
vi.mock("@/lib/openclaw-config", () => ({ regenerateOpenClawConfig: mockRegen }));
vi.mock("@/lib/integrations/oauth-settings", () => ({ deleteOAuthSettings: mockDeleteOAuth }));
vi.mock("@/lib/audit", () => ({ appendAuditLog: mockAudit }));

import { finalizeIntegrationDeletion } from "../finalize-deletion";

const baseConn = {
  id: "conn-1",
  type: "odoo",
  name: "My Odoo",
  description: "",
  credentials: "x",
  data: null,
  status: "active",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  mockRegen.mockClear();
  mockDeleteOAuth.mockClear();
  mockAudit.mockClear();
  mockDb.select.mockReset();
});

describe("finalizeIntegrationDeletion", () => {
  it("regenerates openclaw config and writes audit on strict path", async () => {
    await finalizeIntegrationDeletion({
      actorId: "u1",
      connection: baseConn,
      detachedAgents: [],
    });
    expect(mockRegen).toHaveBeenCalledOnce();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "u1",
        eventType: "config.changed",
        resource: "integration:conn-1",
        outcome: "success",
        detail: { action: "integration_deleted", type: "odoo", name: "My Odoo" },
      })
    );
    expect(mockDeleteOAuth).not.toHaveBeenCalled();
  });

  it("writes detach audit action when agents were detached", async () => {
    const agents = [{ id: "a1", name: "Bot" }];
    await finalizeIntegrationDeletion({
      actorId: "u1",
      connection: baseConn,
      detachedAgents: agents,
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: {
          action: "integration_deleted_with_permissions",
          type: "odoo",
          name: "My Odoo",
          detachedAgents: agents,
        },
      })
    );
  });

  it("cleans up OAuth settings when last google connection is removed", async () => {
    // db.select().from().where() returns [] → no remaining google
    const whereSpy = vi.fn().mockResolvedValue([]);
    mockDb.select.mockReturnValue({ from: () => ({ where: whereSpy }) });
    await finalizeIntegrationDeletion({
      actorId: "u1",
      connection: { ...baseConn, type: "google" },
      detachedAgents: [],
    });
    expect(mockDeleteOAuth).toHaveBeenCalledWith("google");
  });

  it("does not delete OAuth settings when other google connections remain", async () => {
    const whereSpy = vi.fn().mockResolvedValue([{ id: "c2" }]);
    mockDb.select.mockReturnValue({ from: () => ({ where: whereSpy }) });
    await finalizeIntegrationDeletion({
      actorId: "u1",
      connection: { ...baseConn, type: "google" },
      detachedAgents: [],
    });
    expect(mockDeleteOAuth).not.toHaveBeenCalled();
  });

  it("returns 200-path even if regen fails (logs error)", async () => {
    mockRegen.mockRejectedValueOnce(new Error("ws down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      finalizeIntegrationDeletion({ actorId: "u1", connection: baseConn, detachedAgents: [] })
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("propagates OAuth cleanup failure (is not swallowed)", async () => {
    mockDeleteOAuth.mockRejectedValueOnce(new Error("settings DB down"));
    const whereSpy = vi.fn().mockResolvedValue([]);
    mockDb.select.mockReturnValue({ from: () => ({ where: whereSpy }) });
    await expect(
      finalizeIntegrationDeletion({
        actorId: "u1",
        connection: { ...baseConn, type: "google" },
        detachedAgents: [],
      })
    ).rejects.toThrow("settings DB down");
  });
});
