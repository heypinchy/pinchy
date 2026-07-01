import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the on-disk workspace reader so the collector test is hermetic (no fs).
const readWorkspaceFile = vi.fn<(agentId: string, file: string) => string>();
vi.mock("@/lib/workspace", () => ({
  ALLOWED_FILES: ["SOUL.md", "AGENTS.md"] as const,
  readWorkspaceFile: (agentId: string, file: string) => readWorkspaceFile(agentId, file),
}));

const getTemplate = vi.fn();
vi.mock("@/lib/agent-templates/registry", () => ({
  getTemplate: (id: string) => getTemplate(id),
}));

const getPersonalityPreset = vi.fn();
vi.mock("@/lib/personality-presets", () => ({
  getPersonalityPreset: (id: string) => getPersonalityPreset(id),
}));

const resolveDefaultImageModel = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/openclaw-config/default-media-models", () => ({
  resolveDefaultImageModel: () => resolveDefaultImageModel(),
}));

import { collectAgentConfig } from "@/lib/diagnostics/agent-config-collector";

const baseAgent = {
  id: "agt_1",
  name: "Smithers",
  model: "openai/gpt-5.4-mini",
  allowedTools: ["pinchy_web_fetch", "memory"],
  templateId: "smithers",
  personalityPresetId: "the-butler",
};

describe("collectAgentConfig", () => {
  beforeEach(() => {
    readWorkspaceFile.mockReset();
    getTemplate.mockReset();
    getPersonalityPreset.mockReset();
    resolveDefaultImageModel.mockReset();
    readWorkspaceFile.mockReturnValue("");
    getTemplate.mockReturnValue({ name: "Smithers" });
    getPersonalityPreset.mockReturnValue({ name: "The Butler" });
    resolveDefaultImageModel.mockResolvedValue(null);
  });

  it("snapshots the agent id and name as an { id, name } pair", async () => {
    const snap = await collectAgentConfig(baseAgent);
    expect(snap.agent).toEqual({ id: "agt_1", name: "Smithers" });
  });

  it("captures the configured model and derives the provider from the prefix", async () => {
    const snap = await collectAgentConfig(baseAgent);
    expect(snap.model).toBe("openai/gpt-5.4-mini");
    expect(snap.provider).toBe("openai");
  });

  it("falls back to provider 'unknown' when the model has no provider prefix", async () => {
    const snap = await collectAgentConfig({ ...baseAgent, model: "bare-model" });
    expect(snap.provider).toBe("unknown");
  });

  it("captures the per-agent allowed-tools list verbatim", async () => {
    const snap = await collectAgentConfig(baseAgent);
    expect(snap.allowedTools).toEqual(["pinchy_web_fetch", "memory"]);
  });

  it("resolves template and personality preset as { id, name } pairs", async () => {
    const snap = await collectAgentConfig(baseAgent);
    expect(snap.template).toEqual({ id: "smithers", name: "Smithers" });
    expect(snap.personalityPreset).toEqual({ id: "the-butler", name: "The Butler" });
  });

  it("returns null template/preset when unset or not found in the registry", async () => {
    getTemplate.mockReturnValue(undefined);
    const snap = await collectAgentConfig({
      ...baseAgent,
      templateId: null,
      personalityPresetId: null,
    });
    expect(snap.template).toBeNull();
    expect(snap.personalityPreset).toBeNull();
  });

  it("hashes each instruction file as a sha256 map, never the raw prompt", async () => {
    const fakeSecret = "sk-ant-FAKE0123456789abcdefSECRET";
    readWorkspaceFile.mockImplementation((_id, file) =>
      file === "SOUL.md" ? `You are a butler. ${fakeSecret}` : "# Instructions"
    );

    const snap = await collectAgentConfig(baseAgent);

    expect(snap.instructionsHash["SOUL.md"]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(snap.instructionsHash["AGENTS.md"]).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The raw instruction text (and its embedded secret) must not leak.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(fakeSecret);
    expect(serialized).not.toContain("You are a butler");
  });

  it("includes the resolved default image model when one is available", async () => {
    resolveDefaultImageModel.mockResolvedValue("anthropic/claude-vision");
    const snap = await collectAgentConfig(baseAgent);
    expect(snap.imageModel).toBe("anthropic/claude-vision");
  });

  it("omits imageModel when no default resolves", async () => {
    resolveDefaultImageModel.mockResolvedValue(null);
    const snap = await collectAgentConfig(baseAgent);
    expect(snap.imageModel).toBeUndefined();
  });

  it("omits imageModel when the resolver throws (best-effort)", async () => {
    resolveDefaultImageModel.mockRejectedValue(new Error("db down"));
    const snap = await collectAgentConfig(baseAgent);
    expect(snap.imageModel).toBeUndefined();
  });
});
