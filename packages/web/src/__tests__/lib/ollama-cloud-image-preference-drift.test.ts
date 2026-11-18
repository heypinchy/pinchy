import { describe, it, expect } from "vitest";

import { OLLAMA_CLOUD_IMAGE_PREFERENCE } from "@/lib/openclaw-config/default-media-models";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS } from "@/lib/ollama-cloud-models";

// `pickOllamaCloudImageModel()` in default-media-models.ts iterates
// `OLLAMA_CLOUD_IMAGE_PREFERENCE` and returns the first ID that exists in
// `TOOL_CAPABLE_OLLAMA_CLOUD_MODELS`. The function does NOT re-check the
// `vision` flag on the matched entry — it relies on this drift guard.
//
// Why a test instead of a runtime `m.vision &&` check: the TypeScript
// constraint `OllamaCloudModelId` already prevents an unknown ID from
// being added to the preference list, so the only remaining failure mode
// is "ID exists in the catalog but was demoted to `vision: false`". That's
// precisely the #416 fingerprint (devstral was demoted; if it had been on
// the preference list, the demotion alone wouldn't have removed it from
// runtime selection without this guard). Catching at test time means
// CI fails BEFORE the bad config reaches a customer — a runtime check
// would only catch it after deploy.
//
// Pattern matches the existing drift-guard tests:
//   - manifest-tools-drift.test.ts (plugin contracts vs registerTool)
//   - plugin-tool-coverage.test.ts (tools vs E2E assertion presence)
describe("OLLAMA_CLOUD_IMAGE_PREFERENCE drift guard (#416)", () => {
  it("every preference-list entry is present in the curated catalog", () => {
    for (const id of OLLAMA_CLOUD_IMAGE_PREFERENCE) {
      const found = TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.find((m) => m.id === id);
      expect(
        found,
        `OLLAMA_CLOUD_IMAGE_PREFERENCE references "${id}" but it is not in TOOL_CAPABLE_OLLAMA_CLOUD_MODELS. Either restore the catalog entry or remove the preference.`
      ).toBeDefined();
    }
  });

  it("every preference-list entry is flagged vision: true", () => {
    for (const id of OLLAMA_CLOUD_IMAGE_PREFERENCE) {
      const found = TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.find((m) => m.id === id);
      expect(
        found?.vision,
        `OLLAMA_CLOUD_IMAGE_PREFERENCE includes "${id}" but TOOL_CAPABLE_OLLAMA_CLOUD_MODELS marks it vision: false. The image picker would route an image tool call to a text-only model — exactly the #416 failure mode. Either flip the vision flag back to true (and document why) or remove "${id}" from the preference list.`
      ).toBe(true);
    }
  });

  it("preference list is non-empty (otherwise ollama-cloud-only stacks lose imageModel)", () => {
    expect(OLLAMA_CLOUD_IMAGE_PREFERENCE.length).toBeGreaterThan(0);
  });

  it("ranks kimi-k2.6 ahead of gemma4:31b so a tool-using image turn never lands on gemma4", () => {
    // Penny, 2026-07-15. This list is a RANKING, not a filter: uncurated vision
    // models rank behind every curated one (intraProviderVisionRank), so the
    // last curated entry is what a tool-using agent falls back to once the
    // tools-blocked entries (gemini-3-flash-preview, minimax-m3) are skipped.
    //
    // gemma4:31b must not be that model: it corrupts long identifiers across
    // turns (~150-char Graph message ID — see providers/ollama-cloud.ts), and
    // Pinchy's opaque refs are ~230 chars. Blocking minimax-m3 without kimi-k2.6
    // ahead of gemma4:31b just swaps mangled tool args for corrupted refs.
    //
    // Deliberately asserted as ORDER, not as "some entry is unblocked": gemma4
    // is not on any blocklist (its defect is unreliability, not a hard error),
    // so an "at least one usable entry" guard would have passed even in the
    // broken arrangement this test exists to prevent.
    const kimi = OLLAMA_CLOUD_IMAGE_PREFERENCE.indexOf("kimi-k2.6");
    const gemma = OLLAMA_CLOUD_IMAGE_PREFERENCE.indexOf("gemma4:31b");

    expect(kimi, "kimi-k2.6 dropped out of OLLAMA_CLOUD_IMAGE_PREFERENCE").toBeGreaterThanOrEqual(
      0
    );
    if (gemma >= 0) {
      expect(
        kimi,
        "gemma4:31b now outranks kimi-k2.6 in OLLAMA_CLOUD_IMAGE_PREFERENCE. A tool-using agent whose model is text-only would have its image turn routed to gemma4:31b, which corrupts the ~230-char opaque refs Pinchy passes through tool loops. Keep kimi-k2.6 first, or remove gemma4:31b."
      ).toBeLessThan(gemma);
    }
  });
});
