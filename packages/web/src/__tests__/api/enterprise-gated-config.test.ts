import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/api-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn(),
}));

vi.mock("@/lib/gated-config", () => ({
  hasGatedConfig: vi.fn(),
  removeGatedConfig: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

import { requireAdmin } from "@/lib/api-auth";
import { isEnterprise } from "@/lib/enterprise";
import { removeGatedConfig } from "@/lib/gated-config";
import { appendAuditLog } from "@/lib/audit";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";

describe("DELETE /api/enterprise/gated-config", () => {
  let DELETE: typeof import("@/app/api/enterprise/gated-config/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as never);
    vi.mocked(isEnterprise).mockResolvedValue(false);
    vi.mocked(removeGatedConfig).mockResolvedValue({
      groups: [{ id: "g1", name: "Engineering" }],
      agents: [{ id: "a1", name: "Sales Bot" }],
    });
    const mod = await import("@/app/api/enterprise/gated-config/route");
    DELETE = mod.DELETE;
  });

  it("removes gated config and reports counts", async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ groupsRemoved: 1, agentsReset: 1 });
    expect(removeGatedConfig).toHaveBeenCalled();
    expect(recalculateTelegramAllowStores).toHaveBeenCalled();
  });

  it("writes an audit entry with name snapshots (deleted rows are gone)", async () => {
    await DELETE();
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.gated_config_removed",
        outcome: "success",
        detail: expect.objectContaining({
          groupsRemoved: 1,
          agentsReset: 1,
          groups: [{ id: "g1", name: "Engineering" }],
          agents: [{ id: "a1", name: "Sales Bot" }],
        }),
      })
    );
  });

  it("writes the audit entry BEFORE the telegram recalc — a recalc failure must not lose the trail", async () => {
    vi.mocked(recalculateTelegramAllowStores).mockRejectedValueOnce(new Error("recalc boom"));

    await expect(DELETE()).rejects.toThrow("recalc boom");

    // The mutation happened, so the audit entry must exist even though the
    // request failed afterwards.
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "config.gated_config_removed", outcome: "success" })
    );
  });

  it("caps audit list snapshots to keep detail under the size budget", async () => {
    const manyGroups = Array.from({ length: 50 }, (_, i) => ({ id: `g${i}`, name: `Group ${i}` }));
    vi.mocked(removeGatedConfig).mockResolvedValue({ groups: manyGroups, agents: [] });

    await DELETE();

    const call = vi.mocked(appendAuditLog).mock.calls[0][0];
    const detail = call.detail as { groups: unknown[]; groupsRemoved: number; truncated: boolean };
    expect(detail.groupsRemoved).toBe(50);
    expect(detail.groups).toHaveLength(20);
    expect(detail.truncated).toBe(true);
  });

  it("refuses while a license is active (this is an escape hatch, not management)", async () => {
    vi.mocked(isEnterprise).mockResolvedValue(true);
    const res = await DELETE();
    expect(res.status).toBe(409);
    expect(removeGatedConfig).not.toHaveBeenCalled();
  });

  it("requires admin", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }) as never
    );
    const res = await DELETE();
    expect(res.status).toBe(403);
    expect(removeGatedConfig).not.toHaveBeenCalled();
  });
});
