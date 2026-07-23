import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/providers", () => ({
  PROVIDERS: {
    anthropic: { name: "Anthropic", settingsKey: "anthropic_api_key", defaultModel: "anthropic/x" },
    openai: { name: "OpenAI", settingsKey: "openai_api_key", defaultModel: "openai/x" },
    google: { name: "Google", settingsKey: "google_api_key", defaultModel: "google/x" },
    "ollama-cloud": {
      name: "Ollama Cloud",
      settingsKey: "ollama_cloud_api_key",
      defaultModel: "ollama-cloud/x",
    },
    "ollama-local": { name: "Ollama (Local)", settingsKey: "ollama_local_url", defaultModel: "" },
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/openai-compatible-providers", () => ({
  listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
}));

import { countConfiguredProviders, listConfiguredBuiltIns } from "@/lib/provider-count";
import { getSetting } from "@/lib/settings";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import type { OpenAiCompatibleProviderListItem } from "@/lib/openai-compatible-providers";

function customProvider(slug: string): OpenAiCompatibleProviderListItem {
  return {
    id: `id-${slug}`,
    slug,
    displayName: slug,
    baseUrl: `https://${slug}.test/v1`,
    models: [
      {
        id: "m1",
        name: "M1",
        contextWindow: 8192,
        maxTokens: 4096,
        reasoning: false,
        vision: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    keyHint: "abcd",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("countConfiguredProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);
  });

  it("counts 2 built-ins + 1 custom instance as 3", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant";
      if (key === "openai_api_key") return "sk-openai";
      return null;
    });
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([customProvider("acme")]);

    expect(await countConfiguredProviders()).toBe(3);
  });

  it("counts 0 built-ins + 1 custom instance as 1", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([customProvider("acme")]);

    expect(await countConfiguredProviders()).toBe(1);
  });

  it("counts 1 built-in + 0 custom instances as 1", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant";
      return null;
    });
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);

    expect(await countConfiguredProviders()).toBe(1);
  });

  it("counts 0 when nothing is configured", async () => {
    expect(await countConfiguredProviders()).toBe(0);
  });
});

describe("listConfiguredBuiltIns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it("returns only configured built-ins, in PROVIDERS iteration order", async () => {
    // Configure google and anthropic; the result must still be [anthropic, google]
    // (PROVIDERS order), not the order the keys were toggled on — the DELETE route
    // relies on this order to pick a deterministic migration target.
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "google_api_key") return "AIza";
      if (key === "anthropic_api_key") return "sk-ant";
      return null;
    });

    const result = await listConfiguredBuiltIns();
    expect(result.map((p) => p.name)).toEqual(["anthropic", "google"]);
    expect(result[0].config.defaultModel).toBe("anthropic/x");
  });
});
