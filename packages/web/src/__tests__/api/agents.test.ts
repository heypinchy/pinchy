import { describe, it, expect, vi } from "vitest";
import { updateAgent } from "@/lib/agents";

vi.mock("@/db", () => {
  const updateMock = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "1",
            name: "Updated Smithers",
            model: "anthropic/claude-opus-4-6",
          },
        ]),
      }),
    }),
  });
  return { db: { update: updateMock } };
});

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("updateAgent", () => {
  it("should update agent fields and return updated agent", async () => {
    const result = await updateAgent("1", {
      name: "Updated Smithers",
      model: "anthropic/claude-opus-4-6",
    });

    expect(result.name).toBe("Updated Smithers");
    expect(result.model).toBe("anthropic/claude-opus-4-6");
  });

  it("should call regenerateOpenClawConfig after update", async () => {
    const { regenerateOpenClawConfig } = await import("@/lib/openclaw-config");

    await updateAgent("1", {
      name: "Updated Smithers",
    });

    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("should accept tagline in update data", async () => {
    const { db } = await import("@/db");
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "1", tagline: "My new tagline" }]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as never);

    const result = await updateAgent("1", { tagline: "My new tagline" });

    expect(setMock).toHaveBeenCalledWith({ tagline: "My new tagline" });
    expect(result.tagline).toBe("My new tagline");
  });

  it("should accept avatarSeed in update data", async () => {
    const { db } = await import("@/db");
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "1", avatarSeed: "new-seed" }]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as never);

    const result = await updateAgent("1", { avatarSeed: "new-seed" });

    expect(setMock).toHaveBeenCalledWith({ avatarSeed: "new-seed" });
    expect(result.avatarSeed).toBe("new-seed");
  });

  it("should accept personalityPresetId in update data", async () => {
    const { db } = await import("@/db");
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "1", personalityPresetId: "the-professor" }]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as never);

    const result = await updateAgent("1", { personalityPresetId: "the-professor" });

    expect(setMock).toHaveBeenCalledWith({ personalityPresetId: "the-professor" });
    expect(result.personalityPresetId).toBe("the-professor");
  });

  it("should accept null personalityPresetId in update data", async () => {
    const { db } = await import("@/db");
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "1", personalityPresetId: null }]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as never);

    const result = await updateAgent("1", { personalityPresetId: null });

    expect(setMock).toHaveBeenCalledWith({ personalityPresetId: null });
    expect(result.personalityPresetId).toBeNull();
  });

  it("should accept allowedTools and pluginConfig in update data", async () => {
    const { db } = await import("@/db");
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: "1",
            name: "Smithers",
            model: "anthropic/claude-opus-4-6",
            allowedTools: ["shell", "pinchy_ls"],
            pluginConfig: { allowed_paths: ["/data/"] },
          },
        ]),
      }),
    });
    vi.mocked(db.update).mockReturnValueOnce({ set: setMock } as never);

    const result = await updateAgent("1", {
      allowedTools: ["shell", "pinchy_ls"],
      pluginConfig: { allowed_paths: ["/data/"] },
    });

    expect(setMock).toHaveBeenCalledWith({
      allowedTools: ["shell", "pinchy_ls"],
      pluginConfig: { allowed_paths: ["/data/"] },
    });
    expect(result.allowedTools).toEqual(["shell", "pinchy_ls"]);
  });
});
