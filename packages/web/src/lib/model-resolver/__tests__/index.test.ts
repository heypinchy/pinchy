import { describe, expect, it, vi } from "vitest";
import { resolveModelForTemplate } from "..";

vi.mock("@/lib/provider-models", () => ({
  getOllamaLocalModels: vi.fn().mockReturnValue([]),
}));

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
});
