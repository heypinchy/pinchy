import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => {
  const updateMock = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: "agent-1",
          name: "Test Agent",
          model: "anthropic/claude-opus-4-7",
          deletedAt: new Date(),
        },
      ]),
    }),
  });
  const deleteMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  return { db: { update: updateMock, delete: deleteMock } };
});

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/workspace", () => ({
  deleteWorkspace: vi.fn(),
}));

vi.mock("@/lib/telegram-allow-store", () => ({
  recalculateTelegramAllowStores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settings", () => ({
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

import { deleteAgent } from "@/lib/agents";
import { agents, agentConnectionPermissions } from "@/db/schema";
import { db } from "@/db";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { deleteWorkspace } from "@/lib/workspace";

describe("deleteAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-wire the update mock after clearAllMocks
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "agent-1",
            name: "Test Agent",
            model: "anthropic/claude-opus-4-7",
            deletedAt: new Date(),
          },
        ]),
      }),
    } as never);
  });

  it("should soft-delete agent and return the updated row", async () => {
    const result = await deleteAgent("agent-1");

    expect(result).toMatchObject({
      id: "agent-1",
      name: "Test Agent",
      model: "anthropic/claude-opus-4-7",
    });
  });

  it("should call deleteWorkspace with the agent id", async () => {
    await deleteAgent("agent-1");

    expect(deleteWorkspace).toHaveBeenCalledWith("agent-1");
  });

  it("should call regenerateOpenClawConfig after deletion", async () => {
    await deleteAgent("agent-1");

    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  // The deleted agent's bot must leave the runtime config, and its allow list
  // must go, whichever of the two steps fails.
  it("takes the agent out of the runtime config even when the allow-list rewrite fails", async () => {
    vi.mocked(recalculateTelegramAllowStores).mockRejectedValueOnce(
      new Error("Request pinchy.pairing.setAllowFrom timed out")
    );

    await expect(deleteAgent("agent-1")).rejects.toThrow(/timed out/);

    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("rewrites the allow lists even when the config regenerate fails", async () => {
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES openclaw.json"));

    await expect(deleteAgent("agent-1")).rejects.toThrow(/EACCES/);

    expect(recalculateTelegramAllowStores).toHaveBeenCalled();
  });

  // Only one error can reach the caller. The other must not vanish: a
  // rewrite that failed leaves allow lists behind, and the log is the only
  // place anyone learns of it.
  it("logs the allow-list failure when the config regenerate fails too", async () => {
    const recalcError = new Error("Request pinchy.pairing.setAllowFrom timed out");
    vi.mocked(recalculateTelegramAllowStores).mockRejectedValueOnce(recalcError);
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(new Error("EACCES openclaw.json"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deleteAgent("agent-1")).rejects.toThrow(/EACCES/);

    expect(consoleError).toHaveBeenCalledWith(expect.any(String), recalcError);
    consoleError.mockRestore();
  });

  it("should return undefined and skip cleanup when agent not found", async () => {
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const result = await deleteAgent("nonexistent");

    expect(result).toBeUndefined();
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  // ── The onDeleted timing contract ───────────────────────────────────────
  //
  // Same contract as createAgent's onCreated, and it exists for the same
  // reason: the soft-delete commits on line one, and everything after it —
  // the workspace removal, the grant cleanup, two deleteSetting calls, the
  // OpenClaw regen — can throw without rolling it back. A route that awaits
  // this function before registering its audit loses the record of every
  // deletion whose cleanup failed: the agent is gone, the caller 500s, and
  // nothing says who removed it.

  it("fires onDeleted BEFORE the cleanup tail, so a failing tail still gets audited", async () => {
    const calls: string[] = [];
    const onDeleted = vi.fn(() => void calls.push("onDeleted"));
    vi.mocked(regenerateOpenClawConfig).mockImplementationOnce(async () => {
      calls.push("regen");
      throw new Error("openclaw unreachable");
    });

    await expect(deleteAgent("agent-1", onDeleted)).rejects.toThrow("openclaw unreachable");

    expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-1" }));
    expect(calls).toEqual(["onDeleted", "regen"]);
  });

  it("does not fire onDeleted when no agent matched", async () => {
    const onDeleted = vi.fn();
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    await deleteAgent("nonexistent", onDeleted);

    // Nothing was deleted, so there is nothing to record.
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("deleteAgent — soft-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-wire the update mock after clearAllMocks
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "agent-1",
            name: "Test Agent",
            model: "anthropic/claude-opus-4-7",
            deletedAt: new Date(),
          },
        ]),
      }),
    } as never);
  });

  it("sets deletedAt instead of deleting the row", async () => {
    const mockUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "agent-1", name: "Test Agent", deletedAt: new Date() }]),
      }),
    };
    vi.mocked(db.update).mockReturnValueOnce(mockUpdate as never);

    const result = await deleteAgent("agent-1");

    expect(db.update).toHaveBeenCalledWith(agents);
    expect(mockUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) })
    );
    expect(result).toBeDefined();
  });

  it("soft-deletes the agent row but removes its integration permissions", async () => {
    const mockUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "agent-1", name: "Test", deletedAt: new Date() }]),
      }),
    };
    vi.mocked(db.update).mockReturnValueOnce(mockUpdate as never);
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    await deleteAgent("agent-1");

    // The agent row is soft-deleted (deletedAt), never hard-deleted...
    expect(db.delete).not.toHaveBeenCalledWith(agents);
    // ...but its integration grants are removed at the DB level so they can't
    // be re-emitted into the runtime config.
    expect(db.delete).toHaveBeenCalledWith(agentConnectionPermissions);
  });
});
