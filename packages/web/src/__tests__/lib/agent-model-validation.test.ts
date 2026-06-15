import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetchProviderModels = vi.fn();
vi.mock("@/lib/provider-models", () => ({
  fetchProviderModels: () => mockFetchProviderModels(),
}));

import { validateAgentModel } from "@/lib/agent-model-validation";

const OLLAMA_CLOUD = (
  models: Array<{ id: string; name: string; compatible?: boolean; incompatibleReason?: string }>
) => [{ id: "ollama-cloud", name: "Ollama Cloud", models }];

describe("validateAgentModel — tools blocklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects switching to a tools-blocklisted model even when the provider reports it compatible", async () => {
    // The provider says compatible:true (key configured, supports agents) — but
    // gemini-3-flash-preview is unreliable for the tool loop every Pinchy agent
    // drives. The write path must reject it, not just the picker.
    mockFetchProviderModels.mockResolvedValue(
      OLLAMA_CLOUD([
        {
          id: "ollama-cloud/gemini-3-flash-preview",
          name: "gemini-3-flash-preview",
          compatible: true,
        },
        { id: "ollama-cloud/qwen3-vl:235b", name: "qwen3-vl", compatible: true },
      ])
    );

    const err = await validateAgentModel("ollama-cloud/gemini-3-flash-preview");
    expect(err).toBeTruthy();
    expect(err).toContain("Preview models");
  });

  it("rejects a deepseek-r1 model with its specific reason", async () => {
    mockFetchProviderModels.mockResolvedValue(
      OLLAMA_CLOUD([{ id: "ollama-cloud/deepseek-r1:32b", name: "deepseek-r1", compatible: true }])
    );
    expect(await validateAgentModel("ollama-cloud/deepseek-r1:32b")).toContain("DeepSeek-R1");
  });

  it("allows a reliable vision+tools model", async () => {
    mockFetchProviderModels.mockResolvedValue(
      OLLAMA_CLOUD([{ id: "ollama-cloud/qwen3-vl:235b", name: "qwen3-vl", compatible: true }])
    );
    expect(await validateAgentModel("ollama-cloud/qwen3-vl:235b")).toBeNull();
  });

  it("still surfaces the provider's own incompatibility reason (unchanged behavior)", async () => {
    mockFetchProviderModels.mockResolvedValue(
      OLLAMA_CLOUD([
        {
          id: "ollama-cloud/some-model",
          name: "some-model",
          compatible: false,
          incompatibleReason: "Provider not configured",
        },
      ])
    );
    expect(await validateAgentModel("ollama-cloud/some-model")).toBe("Provider not configured");
  });

  it("still reports an unavailable model whose provider is not configured", async () => {
    mockFetchProviderModels.mockResolvedValue(OLLAMA_CLOUD([]));
    expect(await validateAgentModel("ollama-cloud/whatever")).toContain("not available");
  });
});
