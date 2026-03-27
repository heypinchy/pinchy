import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => {
  const updateMock = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: "agent-1",
          name: "Test Agent",
          model: "anthropic/claude-opus-4-6",
          deletedAt: new Date(),
        },
      ]),
    }),
  });
  const deleteMock = vi.fn();
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
  clearAllowStoreForAccount: vi.fn(),
}));

vi.mock("@/lib/settings", () => ({
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

import { deleteAgent } from "@/lib/agents";
import { agents } from "@/db/schema";
import { db } from "@/db";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
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
            model: "anthropic/claude-opus-4-6",
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
      model: "anthropic/claude-opus-4-6",
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
            model: "anthropic/claude-opus-4-6",
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

  it("does NOT call db.delete", async () => {
    const mockUpdate = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ id: "agent-1", name: "Test", deletedAt: new Date() }]),
      }),
    };
    vi.mocked(db.update).mockReturnValueOnce(mockUpdate as never);

    await deleteAgent("agent-1");

    expect(db.delete).not.toHaveBeenCalled();
  });
});
