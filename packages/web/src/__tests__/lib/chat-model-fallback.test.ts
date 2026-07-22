import { afterEach, describe, expect, it, vi } from "vitest";

// Same-provider chat-model fallback resolver. It is pure preference logic over
// three edges (is the provider configured? what is its LIVE default? is that
// default blocked?), so we mock the edges and assert the chain.
const getSetting = vi.fn<(key: string) => Promise<string | null>>();
// getDefaultModel's real contract is Promise<string> — it never resolves null,
// falling back to PROVIDERS[provider].defaultModel. Mock the true shape.
const getDefaultModel = vi.fn<(provider: string) => Promise<string>>();
const getAgentModelBlockReason = vi.fn<(model: string) => string | null>();

vi.mock("@/lib/settings", () => ({ getSetting: (k: string) => getSetting(k) }));
vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: (p: string) => getDefaultModel(p),
}));
vi.mock("@/lib/model-resolver/blocklist", () => ({
  getAgentModelBlockReason: (m: string) => getAgentModelBlockReason(m),
}));

import { resolveChatModelFallbackChain } from "@/lib/openclaw-config/chat-model-fallback";

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveChatModelFallbackChain", () => {
  it("falls back to the same provider's LIVE default when the primary is retired", async () => {
    // apsa scenario: an agent pinned to a retired ollama-cloud model. The live
    // catalog no longer lists it, but getDefaultModel resolves the balanced
    // live pick — that is the fallback OpenClaw retries so the run recovers.
    getSetting.mockImplementation(async (key) =>
      key === "ollama_cloud_api_key" ? "sk-present" : null
    );
    getDefaultModel.mockResolvedValue("ollama-cloud/kimi-k2.6");
    getAgentModelBlockReason.mockReturnValue(null);

    const chain = await resolveChatModelFallbackChain("ollama-cloud/gemini-3-flash-preview");

    expect(chain).toEqual(["ollama-cloud/kimi-k2.6"]);
  });

  it("maps the bare `ollama/` prefix to the ollama-local provider", async () => {
    getSetting.mockImplementation(async (key) =>
      key === "ollama_local_url" ? "http://host.docker.internal:11434" : null
    );
    getDefaultModel.mockImplementation(async (provider) =>
      provider === "ollama-local" ? "ollama/qwen3" : "unused/other-provider-default"
    );
    getAgentModelBlockReason.mockReturnValue(null);

    const chain = await resolveChatModelFallbackChain("ollama/some-retired-model");

    expect(chain).toEqual(["ollama/qwen3"]);
  });

  it("returns no fallback when the same live default equals the primary", async () => {
    // The primary is still live, so its provider default resolves to itself —
    // emitting it as a fallback would be a useless duplicate.
    getSetting.mockResolvedValue("sk-present");
    getDefaultModel.mockResolvedValue("anthropic/claude-sonnet-4-6");
    getAgentModelBlockReason.mockReturnValue(null);

    const chain = await resolveChatModelFallbackChain("anthropic/claude-sonnet-4-6");

    expect(chain).toEqual([]);
  });

  it("returns no fallback when the primary's provider is not configured", async () => {
    // No key → the same-provider default would 401 at runtime, so it is not a
    // usable fallback. (Also the state every unit test with null settings hits,
    // keeping the emitted agent shape a bare string there.)
    getSetting.mockResolvedValue(null);
    getDefaultModel.mockResolvedValue("ollama-cloud/kimi-k2.6");
    getAgentModelBlockReason.mockReturnValue(null);

    const chain = await resolveChatModelFallbackChain("ollama-cloud/gemini-3-flash-preview");

    expect(chain).toEqual([]);
  });

  it("drops a same-provider default that the tools blocklist rejects", async () => {
    // Chat fallbacks drive tool loops, so a blocklisted default (e.g. one that
    // mangles nested tool arguments) must not be handed out — unlike the vision
    // chain, which describes images and applies no blocklist.
    getSetting.mockResolvedValue("sk-present");
    getDefaultModel.mockResolvedValue("ollama-cloud/minimax-m3");
    getAgentModelBlockReason.mockImplementation((m) =>
      m === "ollama-cloud/minimax-m3" ? "mangles nested tool arguments" : null
    );

    const chain = await resolveChatModelFallbackChain("ollama-cloud/gemini-3-flash-preview");

    expect(chain).toEqual([]);
  });

  it.each([null, undefined, ""])(
    "returns no fallback for a missing primary model (%s)",
    async (primary) => {
      // agents.model is nullable in the DB; the resolver must not throw on it.
      getSetting.mockResolvedValue("sk-present");
      getAgentModelBlockReason.mockReturnValue(null);

      const chain = await resolveChatModelFallbackChain(primary as unknown as string);

      expect(chain).toEqual([]);
      expect(getDefaultModel).not.toHaveBeenCalled();
    }
  );

  it("returns no fallback for an unprefixed / unknown model id", async () => {
    getSetting.mockResolvedValue("sk-present");
    getDefaultModel.mockResolvedValue("anthropic/claude-sonnet-4-6");
    getAgentModelBlockReason.mockReturnValue(null);

    const chain = await resolveChatModelFallbackChain("just-a-name-no-provider");

    expect(chain).toEqual([]);
    // An unknown prefix must never trigger a provider lookup — it has no provider.
    expect(getDefaultModel).not.toHaveBeenCalled();
  });
});
