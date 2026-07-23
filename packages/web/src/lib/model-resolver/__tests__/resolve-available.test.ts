import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolverInput, ResolverResult } from "../types";

// Live-availability wrapper around the pure tier resolvers (#883). It has three
// I/O edges — the pick (resolveModelForTemplate), the live catalog
// (fetchProviderModels), the substitute (getDefaultModel) — plus a capability
// lookup. Mock the edges and assert the substitution policy.
const resolveModelForTemplate = vi.fn<(input: ResolverInput) => Promise<ResolverResult>>();
const fetchProviderModels = vi.fn<() => Promise<{ id: string; models: { id: string }[] }[]>>();
const getDefaultModel = vi.fn<(provider: string) => Promise<string>>();
const modelCapabilityStatus =
  vi.fn<(model: string, cap: string) => "supported" | "unsupported" | "unknown">();

vi.mock("@/lib/model-resolver/index", () => ({
  resolveModelForTemplate: (i: ResolverInput) => resolveModelForTemplate(i),
}));
vi.mock("@/lib/provider-models", () => ({
  fetchProviderModels: () => fetchProviderModels(),
  getDefaultModel: (p: string) => getDefaultModel(p),
}));
vi.mock("@/lib/model-capabilities/cache", () => ({
  ensureModelCapabilityCacheLoaded: () => Promise.resolve(),
  modelCapabilityStatus: (m: string, c: string) => modelCapabilityStatus(m, c),
}));

import { resolveAvailableModelForTemplate } from "@/lib/model-resolver/resolve-available";
import { TemplateCapabilityUnavailableError } from "@/lib/model-resolver/types";

const balancedVisionHint: ResolverInput = {
  provider: "anthropic",
  hint: { tier: "balanced", capabilities: ["vision", "tools"] },
};

function pick(model: string): ResolverResult {
  return { model, reason: `stub: ${model}`, fallbackUsed: false };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveAvailableModelForTemplate", () => {
  it("returns the resolver pick unchanged when it is in the live catalog", async () => {
    resolveModelForTemplate.mockResolvedValue(pick("anthropic/claude-sonnet-4-6"));
    fetchProviderModels.mockResolvedValue([
      { id: "anthropic", models: [{ id: "anthropic/claude-sonnet-4-6" }] },
    ]);

    const result = await resolveAvailableModelForTemplate(balancedVisionHint);

    expect(result.model).toBe("anthropic/claude-sonnet-4-6");
    // A live pick must never trigger the substitute lookup.
    expect(getDefaultModel).not.toHaveBeenCalled();
  });

  it("substitutes the provider's live default when the pick is retired and keeps the capabilities", async () => {
    // The hardcoded resolver pick was retired upstream, so it is absent from the
    // live catalog; the provider's live default is capable and takes its place.
    resolveModelForTemplate.mockResolvedValue(pick("anthropic/claude-sonnet-4-6"));
    fetchProviderModels.mockResolvedValue([
      { id: "anthropic", models: [{ id: "anthropic/claude-haiku-4-5-20251001" }] },
    ]);
    getDefaultModel.mockResolvedValue("anthropic/claude-haiku-4-5-20251001");
    modelCapabilityStatus.mockReturnValue("supported");

    const result = await resolveAvailableModelForTemplate(balancedVisionHint);

    expect(result.model).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(result.fallbackUsed).toBe(true);
    // The reason must name both the retired pick and its live replacement so the
    // creating route's audit detail records the substitution.
    expect(result.reason).toContain("anthropic/claude-sonnet-4-6");
    expect(result.reason).toContain("anthropic/claude-haiku-4-5-20251001");
  });

  it("throws (loud) rather than silently downgrading when the live default lacks a required capability", async () => {
    resolveModelForTemplate.mockResolvedValue(pick("anthropic/claude-sonnet-4-6"));
    fetchProviderModels.mockResolvedValue([
      { id: "anthropic", models: [{ id: "anthropic/text-only-default" }] },
    ]);
    getDefaultModel.mockResolvedValue("anthropic/text-only-default");
    // The substitute is KNOWN to have tools but not vision.
    modelCapabilityStatus.mockImplementation((_m, cap) =>
      cap === "vision" ? "unsupported" : "supported"
    );

    await expect(resolveAvailableModelForTemplate(balancedVisionHint)).rejects.toBeInstanceOf(
      TemplateCapabilityUnavailableError
    );
    await expect(resolveAvailableModelForTemplate(balancedVisionHint)).rejects.toMatchObject({
      missingCapabilities: ["vision"],
    });
  });

  it("keeps the pick best-effort when getDefaultModel's substitute is itself absent from the live catalog", async () => {
    // The pick is absent from the live catalog, but getDefaultModel falls back
    // to a hardcoded anchor/default that is ALSO absent (an incomplete or empty
    // /v1/models — e.g. a provider whose catalog omits the current picks, or a
    // transient partial response). getDefaultModel is NOT "live by construction"
    // in that case, so the catalog is too incomplete to trust as a retirement
    // signal. Only act on a confirmed signal: keep the pick, like a fetch
    // failure — never pin an unverified substitute, never throw.
    resolveModelForTemplate.mockResolvedValue(pick("google/gemini-2.5-pro"));
    fetchProviderModels.mockResolvedValue([
      // pick absent; only a sibling model is listed.
      { id: "google", models: [{ id: "google/gemini-2.5-flash" }] },
    ]);
    // Anchor fallback resolves back to a model the catalog does not list.
    getDefaultModel.mockResolvedValue("google/gemini-2.5-pro");

    const result = await resolveAvailableModelForTemplate({
      provider: "google",
      hint: { tier: "balanced", capabilities: ["tools", "long-context"] },
    });

    expect(result.model).toBe("google/gemini-2.5-pro");
    expect(result.fallbackUsed).toBe(false);
    // Best-effort keep must never consult the capability gate.
    expect(modelCapabilityStatus).not.toHaveBeenCalled();
  });

  it("substitutes rather than throwing when the live default's capabilities are unknown (unknown ≠ incapable)", async () => {
    // The live default is a brand-new model the provider added AFTER this
    // release, so it is absent from the curated capability cache and every
    // capability reads "unknown". A missing cache row is not proof of a missing
    // capability — blocking creation here would be a false 422 in exactly the
    // retire-and-replace scenario this wrapper exists to handle. So substitute
    // best-effort rather than throw.
    resolveModelForTemplate.mockResolvedValue(pick("anthropic/claude-sonnet-4-6"));
    fetchProviderModels.mockResolvedValue([
      { id: "anthropic", models: [{ id: "anthropic/claude-brandnew-6" }] },
    ]);
    getDefaultModel.mockResolvedValue("anthropic/claude-brandnew-6");
    modelCapabilityStatus.mockReturnValue("unknown");

    const result = await resolveAvailableModelForTemplate(balancedVisionHint);

    expect(result.model).toBe("anthropic/claude-brandnew-6");
    expect(result.fallbackUsed).toBe(true);
    // The reason must flag that capabilities could not be verified, so the
    // creating route's audit detail is honest about the best-effort pin.
    expect(result.reason).toMatch(/unverified/i);
  });

  it("skips the live check for ollama-local (it already resolves against installed models)", async () => {
    resolveModelForTemplate.mockResolvedValue(pick("ollama/qwen3"));

    const result = await resolveAvailableModelForTemplate({
      provider: "ollama-local",
      hint: { tier: "balanced", capabilities: ["tools"] },
    });

    expect(result.model).toBe("ollama/qwen3");
    // ollama-local must not consult the cloud live catalog at all.
    expect(fetchProviderModels).not.toHaveBeenCalled();
  });

  it("substitutes without a capability check when the template requires no capabilities", async () => {
    resolveModelForTemplate.mockResolvedValue(pick("ollama-cloud/some-retired-model"));
    fetchProviderModels.mockResolvedValue([
      { id: "ollama-cloud", models: [{ id: "ollama-cloud/kimi-k2.6" }] },
    ]);
    getDefaultModel.mockResolvedValue("ollama-cloud/kimi-k2.6");

    const result = await resolveAvailableModelForTemplate({
      provider: "ollama-cloud",
      hint: { tier: "balanced" },
    });

    expect(result.model).toBe("ollama-cloud/kimi-k2.6");
    expect(result.fallbackUsed).toBe(true);
    // No required capabilities → no capability gate.
    expect(modelCapabilityStatus).not.toHaveBeenCalled();
  });

  it("keeps the pick (best-effort) when a fetch failure leaves it present in the static fallback catalog", async () => {
    // On a live-fetch failure, fetchProviderModels returns FALLBACK_MODELS, which
    // still lists the pick — so it reads as available and is kept unchanged
    // rather than substituted against stale data.
    resolveModelForTemplate.mockResolvedValue(pick("ollama-cloud/kimi-k2.6"));
    fetchProviderModels.mockResolvedValue([
      { id: "ollama-cloud", models: [{ id: "ollama-cloud/kimi-k2.6" }] },
    ]);

    const result = await resolveAvailableModelForTemplate({
      provider: "ollama-cloud",
      hint: { tier: "balanced", capabilities: ["vision", "tools"] },
    });

    expect(result.model).toBe("ollama-cloud/kimi-k2.6");
    expect(getDefaultModel).not.toHaveBeenCalled();
  });
});
