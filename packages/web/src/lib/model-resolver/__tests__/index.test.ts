import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveModelForTemplate } from "..";
import { listOpenAiCompatibleProviders } from "@/lib/openai-compatible-providers";
import type { OpenAiCompatibleProviderListItem } from "@/lib/openai-compatible-providers";

vi.mock("@/lib/provider-models", () => ({
  getOllamaLocalModels: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/openai-compatible-providers", () => ({
  listOpenAiCompatibleProviders: vi.fn().mockResolvedValue([]),
}));

/** Minimal typed custom-provider list item; only slug + models[].id/name matter here. */
function customProvider(
  slug: string,
  modelDefs: { id: string; name: string }[]
): OpenAiCompatibleProviderListItem {
  return {
    id: `id-${slug}`,
    slug,
    displayName: slug,
    baseUrl: `https://${slug}.test/v1`,
    models: modelDefs.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: 8192,
      maxTokens: 4096,
      reasoning: false,
      vision: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    keyHint: "abcd",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);
});

describe("resolveModelForTemplate", () => {
  it("routes anthropic hints to anthropic resolver", async () => {
    const r = await resolveModelForTemplate({
      hint: { tier: "reasoning" },
      provider: "anthropic",
    });
    expect(r.model).toMatch(/opus/);
  });

  it("routes openai hints to openai resolver", async () => {
    const r = await resolveModelForTemplate({
      hint: { tier: "fast" },
      provider: "openai",
    });
    expect(r.model).toMatch(/4o-mini|mini/);
  });

  it("routes google hints to google resolver", async () => {
    const r = await resolveModelForTemplate({
      hint: { tier: "balanced" },
      provider: "google",
    });
    expect(r.model).toMatch(/gemini/i);
  });

  it("routes ollama-cloud hints to ollama-cloud resolver", async () => {
    const r = await resolveModelForTemplate({
      hint: { tier: "fast" },
      provider: "ollama-cloud",
    });
    expect(r.model).toContain("ollama-cloud/");
  });

  it("resolves a custom OpenAI-compatible slug to its instance default model (#894)", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([
      customProvider("acme", [
        { id: "acme-large", name: "Acme Large" },
        { id: "acme-small", name: "Acme Small" },
      ]),
    ]);

    const r = await resolveModelForTemplate({
      hint: { tier: "reasoning" },
      provider: "acme",
    });

    // Same shape as the built-in branches: { model, reason, fallbackUsed }.
    expect(r).toEqual({
      model: "acme/acme-large",
      reason: expect.stringContaining("acme"),
      fallbackUsed: false,
    });
  });

  it("throws a defined 'Unknown provider' error for an unknown slug (#894)", async () => {
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([]);

    await expect(
      resolveModelForTemplate({ hint: { tier: "fast" }, provider: "ghost" })
    ).rejects.toThrow("Unknown provider: ghost");
  });

  it("throws a defined error (not a raw TypeError) for a matched instance with zero models (#894)", async () => {
    // Unreachable today (create schema guarantees models.min(1)), but the guard
    // keeps resolveCustomProvider symmetric with getDefaultModel — neither may
    // raw-TypeError on `models[0]`.
    vi.mocked(listOpenAiCompatibleProviders).mockResolvedValue([customProvider("empty", [])]);

    const result = resolveModelForTemplate({ hint: { tier: "fast" }, provider: "empty" });
    await expect(result).rejects.toThrow(/no models/i);
    await expect(result).rejects.not.toThrow(TypeError);
  });
});
