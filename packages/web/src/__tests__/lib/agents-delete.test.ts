import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db", () => {
  const deleteMock = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([
        {
          id: "agent-1",
          name: "Test Agent",
          model: "anthropic/claude-opus-4-6",
        },
      ]),
    }),
  });
  return { db: { delete: deleteMock } };
});

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/workspace", () => ({
  deleteWorkspace: vi.fn(),
}));

import { deleteAgent } from "@/lib/agents";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteWorkspace } from "@/lib/workspace";

describe("deleteAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should delete agent from DB and return it", async () => {
    const result = await deleteAgent("agent-1");

    expect(result).toEqual({
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
    const { db } = await import("@/db");
    vi.mocked(db.delete).mockReturnValueOnce({
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
