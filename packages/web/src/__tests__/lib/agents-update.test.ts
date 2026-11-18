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
import { updateAgent, AgentRuntimeUpdateError } from "@/lib/agents";

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
    await updateAgent("agent-1", { model: "openai/gpt-5.4" });
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

// Two steps, two very different failures, and until #1095 the caller could not
// tell them apart. The row is written FIRST and the runtime is told second, so:
//
//   - the write fails      → nothing persisted, the user must try again
//   - the regeneration fails → the change IS persisted, the runtime is stale
//
// The first fix for #1095 caught both in one `catch` and answered "Settings
// were saved, but the agent runtime was not updated" — true for the second,
// and for the first the same class of unfounded claim as the flat "Failed to
// save some settings" it replaced, only pointing the other way. A user who
// believes it stops retrying a change that never landed.
//
// So the distinction lives in the type, not in string-matching an errno at the
// route: only the regeneration failure is wrapped.
describe("updateAgent — which half failed (#1095)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const returning = vi.fn().mockResolvedValue([mockAgent]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);
  });

  it("wraps a regeneration failure as AgentRuntimeUpdateError", async () => {
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(
      new Error("EACCES: permission denied, open '/openclaw-config/workspaces/agent-1/TOOLS.md'")
    );

    await expect(updateAgent("agent-1", { model: "openai/gpt-5.4" })).rejects.toBeInstanceOf(
      AgentRuntimeUpdateError
    );
  });

  it("carries the row that WAS persisted, plus the original cause", async () => {
    const cause = new Error(
      "EACCES: permission denied, open '/openclaw-config/workspaces/agent-1/TOOLS.md'"
    );
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(cause);

    const thrown = await updateAgent("agent-1", { model: "openai/gpt-5.4" }).then(
      () => null,
      (e: unknown) => e
    );

    expect(thrown).toBeInstanceOf(AgentRuntimeUpdateError);
    const err = thrown as AgentRuntimeUpdateError;
    // The row matters: the caller needs it to build an honest audit diff for a
    // change that really did happen.
    expect(err.agent).toMatchObject({ id: "agent-1" });
    expect(err.cause).toBe(cause);
    // And the message must still name the errno — that text is the whole
    // reason #1095 needed an SSH session to diagnose.
    expect(err.message).toContain("EACCES");
  });

  it("does NOT wrap a failure of the row write itself — nothing was persisted", async () => {
    const dbError = new Error("connection terminated unexpectedly");
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(dbError) });
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where }) } as never);

    await expect(updateAgent("agent-1", { model: "openai/gpt-5.4" })).rejects.toBe(dbError);
  });
});
