import { afterEach, describe, expect, it, vi } from "vitest";

// Claude Haiku 5.5 is tools-usable on the pinned OpenClaw (2026.7.1) for one
// reason only: Pinchy declares it `reasoning: false` in the Anthropic catalog,
// and the runtime's Anthropic transport then omits `thinking` altogether.
// Declared `reasoning: true`, the same runtime resolves the default thinking
// level to "medium" and sends `thinking: {type: "enabled", budget_tokens}` —
// which Haiku 5.5 rejects with HTTP 400 on every turn. So the block must come
// back by itself the moment that declaration flips, not wait for someone to
// remember this file.
describe("the Haiku 5.5 tools block follows the catalog's reasoning flag", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/openclaw-builtin-models");
    vi.resetModules();
  });

  async function loadBlocklistWithHaiku(entry: { reasoning: boolean } | null) {
    vi.resetModules();
    vi.doMock("@/lib/openclaw-builtin-models", () => ({
      getModelCatalogForProvider: (provider: string) =>
        provider === "anthropic" && entry ? [{ id: "claude-haiku-5-5", ...entry }] : [],
    }));
    return import("../blocklist");
  }

  it("blocks Haiku 5.5 for tools when the catalog declares it reasoning:true", async () => {
    const { isBlocked } = await loadBlocklistWithHaiku({ reasoning: true });
    expect(isBlocked("anthropic/claude-haiku-5-5", ["tools"])).toBe(true);
  });

  it("blocks Haiku 5.5 for tools when the catalog does not declare it at all", async () => {
    const { isBlocked } = await loadBlocklistWithHaiku(null);
    expect(isBlocked("anthropic/claude-haiku-5-5", ["tools"])).toBe(true);
  });

  it("allows Haiku 5.5 for tools when the catalog declares it reasoning:false", async () => {
    const { isBlocked } = await loadBlocklistWithHaiku({ reasoning: false });
    expect(isBlocked("anthropic/claude-haiku-5-5", ["tools"])).toBe(false);
  });

  it("never lifts the block for the rest of the family, whatever the catalog says", async () => {
    const { isBlocked } = await loadBlocklistWithHaiku({ reasoning: false });
    for (const model of [
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-fable-5-1",
    ]) {
      expect(isBlocked(model, ["tools"]), model).toBe(true);
    }
  });
});
