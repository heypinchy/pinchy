import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAgent = {
  id: "agent-1",
  name: "Smithers",
  model: "anthropic/claude-haiku-4-5-20251001",
};

vi.mock("@/db", () => {
  const returning = vi
    .fn()
    .mockResolvedValue([
      { id: "agent-1", name: "Smithers", model: "anthropic/claude-haiku-4-5-20251001" },
    ]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { db: { update } };
});

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/db";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { updateAgent } from "@/lib/agents";

describe("updateAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const returning = vi.fn().mockResolvedValue([mockAgent]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);
  });

  it("returns the updated agent", async () => {
    const result = await updateAgent("agent-1", { name: "New Name" });
    expect(result).toMatchObject({ id: "agent-1" });
  });

  it("calls regenerateOpenClawConfig when name changes", async () => {
    await updateAgent("agent-1", { name: "New Name" });
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("calls regenerateOpenClawConfig when model changes", async () => {
    await updateAgent("agent-1", { model: "openai/gpt-4o" });
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("calls regenerateOpenClawConfig when allowedTools changes", async () => {
    await updateAgent("agent-1", { allowedTools: ["web_search"] });
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("calls regenerateOpenClawConfig when pluginConfig changes", async () => {
    await updateAgent("agent-1", {
      pluginConfig: { "pinchy-files": { allowed_paths: ["/data/"] } },
    });
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("does NOT call regenerateOpenClawConfig when only greetingMessage changes", async () => {
    await updateAgent("agent-1", { greetingMessage: "Hello!" });
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("does NOT call regenerateOpenClawConfig when only tagline changes", async () => {
    await updateAgent("agent-1", { tagline: "Your AI assistant" });
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("does NOT call regenerateOpenClawConfig when only visibility changes", async () => {
    await updateAgent("agent-1", { visibility: "all" });
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("does NOT call regenerateOpenClawConfig when only avatarSeed changes", async () => {
    await updateAgent("agent-1", { avatarSeed: "abc123" });
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });
});
