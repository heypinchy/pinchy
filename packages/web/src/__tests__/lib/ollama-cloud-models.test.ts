import { describe, it, expect } from "vitest";
import {
  TOOL_CAPABLE_OLLAMA_CLOUD_MODELS,
  TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS,
  VISION_OLLAMA_CLOUD_MODEL_IDS,
  type OllamaCloudModel,
} from "@/lib/ollama-cloud-models";

/**
 * These assertions pin the capability flags that Pinchy curates for Ollama
 * Cloud models to what the live API actually does — not to what the
 * ollama.com/library/<name> pages claim. The pages are documented as
 * unreliable (see the file header), so each non-obvious flag below was
 * verified empirically against https://ollama.com/v1/chat/completions:
 *
 *  - Vision was probed by sending base64 image payloads carrying a random,
 *    non-guessable 4-digit number plus a colored circle and checking the
 *    reply against the ground truth across several distinct images. A model
 *    that returns the correct number/color sees the image; one that returns
 *    HTTP 400 ("does not support image input") or hallucinates wrong content
 *    on a 200 does not.
 *  - Tools were probed by offering a function schema and checking for a
 *    structured `tool_calls` response.
 */
const byId = (id: string): OllamaCloudModel | undefined =>
  TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.find((m) => m.id === id);

describe("Ollama Cloud model catalog — empirically verified capabilities", () => {
  it("includes minimax-m3 with vision and reasoning", () => {
    // Library tags: "vision tools thinking cloud". Empirically confirmed:
    // read a random 4-digit number AND the circle color correctly across 4
    // distinct images (3/3 + 3/3), and emits structured tool_calls.
    const m = byId("minimax-m3");
    expect(m).toBeDefined();
    expect(m!.vision).toBe(true);
    expect(m!.reasoning).toBe(true);
  });

  it("promotes qwen3.5:397b to vision — the 2026-06 hallucination is gone (2026-07-30)", () => {
    // This assertion is the REVERSE of what it pinned until 2026-07-30, and the
    // reversal is the interesting part. In 2026-06 the endpoint returned HTTP
    // 200 on image payloads and hallucinated the contents (colours 1/3, numbers
    // 0/3 across distinct test images) — accepted-but-blind, the failure a
    // library tag cannot show you.
    //
    // Re-probed 2026-07-30 with 512x512 PNGs carrying a random 4-digit number
    // and a coloured circle: 6/6 trials returned BOTH correctly. Guessing one
    // 4-digit number is ~1/9000, so six in a row is sight, not luck.
    //
    // Kept as an explicit test rather than folded into a generic vision list
    // because the direction of travel matters: anyone who finds the old comment
    // in git history should see that the flip was measured, not assumed.
    const m = byId("qwen3.5:397b");
    expect(m).toBeDefined();
    expect(m!.vision).toBe(true);
    expect(VISION_OLLAMA_CLOUD_MODEL_IDS.has("qwen3.5:397b")).toBe(true);
  });

  it("drops qwen3-next:80b — tool calls still flaky on Ollama Cloud", () => {
    // The model is still returned by /v1/models, but on the OpenAI-completions
    // endpoint OpenClaw uses it originally never emitted a structured
    // tool_call (empty content or a malformed `<tools> {…} </tools>` text
    // blob, even with tool_choice:"required"). A 2026-06-12 re-probe after it
    // reappeared in the live list showed the defect is now intermittent
    // instead of permanent: 3/4 rounds emitted clean tool_calls, but one
    // round returned empty content with no call — the original failure mode.
    // Every Pinchy agent uses tools (files/context/docs), so a model that
    // silently skips a requested tool call once in four requests must not be
    // surfaced as tool-capable.
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain("qwen3-next:80b");
  });

  it("includes nemotron-3-ultra with reasoning, text-only", () => {
    // Library tags: "thinking tools cloud", input text-only, 256K context.
    // Tools confirmed empirically 2026-06-11 against /v1/chat/completions:
    // structured tool_calls in 4/4 single-turn rounds plus a clean multi-turn
    // follow-up call after a tool result.
    const m = byId("nemotron-3-ultra");
    expect(m).toBeDefined();
    expect(m!.reasoning).toBe(true);
    expect(m!.vision).toBe(false);
    expect(m!.contextWindow).toBe(262144);
  });

  it("includes glm-5.2 with reasoning, text-only, 976K context", () => {
    // Added 2026-06-17 (Ollama announced GLM-5.2). Library tags
    // "tools thinking cloud", Text-only input, 976K context. Verified against
    // the live API: a structured tool_call in round 1 plus a clean multi-turn
    // follow-up (HTTP 200 with a coherent answer after a tool result), and
    // HTTP 400 "this model does not support image input" on image payloads —
    // text-only, like the rest of the GLM line.
    const m = byId("glm-5.2");
    expect(m).toBeDefined();
    expect(m!.reasoning).toBe(true);
    expect(m!.vision).toBe(false);
    expect(m!.contextWindow).toBe(999424);
    expect(VISION_OLLAMA_CLOUD_MODEL_IDS.has("glm-5.2")).toBe(false);
  });

  it("dropped kimi-k2:1t — Ollama removed it from the cloud catalog (2026-06-17)", () => {
    // Verified tool-capable on 2026-06-12 (4/4 single-turn + a clean multi-turn
    // follow-up), but the 2026-06-17 `models:discover` sweep found it gone from
    // /v1/models. Leaving a model the live API no longer serves would resurface
    // the llama3.3:70b -> HTTP 404 class of bug, so it was dropped.
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain("kimi-k2:1t");
  });

  it("keeps cogito-2.1:671b out — leaks raw tool-call template text", () => {
    // Probed 2026-06-11: in 1 of 4 rounds the model emitted a raw
    // DeepSeek-style tool-call template (`<|tool▁calls▁begin|>…`) as plain
    // assistant text instead of a structured tool_call. An agent on this
    // model would intermittently print template gibberish into the chat
    // instead of acting.
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain("cogito-2.1:671b");
  });

  it("keeps kimi-k2-thinking out — serving is broken (#305)", () => {
    // Removed in #305 for HTTP 500s. Re-probed 2026-06-11: now every request
    // fails HTTP 400 "prompt too long; exceeded max context length by 691
    // tokens" — even for a ~1k-token prompt. The serving-side context
    // accounting is broken, so the model is unusable regardless of tags.
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain("kimi-k2-thinking");
  });

  it("keeps the gemma3 family out — no usable tool path on Ollama Cloud", () => {
    // Probed 2026-06-12. gemma3:4b leaks pseudo tool calls as a ```python
    // text block in 4/4 rounds (no structured tool_calls). gemma3:12b
    // returns HTTP 500 for every tools request, persisting across retries.
    // gemma3:27b mostly emits clean single-turn tool_calls (4/4, then 3/4
    // with one text leak on the confirmation re-run) but returns HTTP 500 as
    // soon as the conversation history contains a tool result — reproduced
    // across two independent runs, the same multi-turn failure mode that got
    // kimi-k2-thinking removed in #305. Every Pinchy agent runs multi-turn
    // tool loops, so all three stay out despite the library page's vision tag.
    //
    // Re-probed 2026-06-17 (during the GLM-5.2 sweep): all three now passed a
    // single multi-turn round (round-2 HTTP 200 with a coherent answer). That
    // flip-flop is exactly the intermittency that disqualified qwen3-next — one
    // clean run does not certify reliability — and gemma3 is an older sibling
    // of gemma4:31b, which we already carry with verified vision. Vision could
    // not be re-confirmed (the image endpoint was returning blanket 5xx that
    // day). They stay out until a deliberate multi-run + vision re-evaluation.
    //
    // Re-triaged 2026-06-25 (v0.7.x catalog sweep): ollama.com/library/gemma3
    // now lists only vision — no "tools" tag at all — so the family isn't even
    // a tool candidate any more. No tag → not added (every Pinchy agent uses
    // tools); the prior multi-turn-500 evidence stands.
    for (const id of ["gemma3:4b", "gemma3:12b", "gemma3:27b"]) {
      expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain(id);
    }
  });

  it("includes kimi-k2.7-code with reasoning, vision since 2026-07-30, 256K context", () => {
    // Added 2026-06-25 (v0.7.x catalog sweep). ollama.com/library/kimi-k2.7-code
    // lists tools + thinking + vision (image/video via MoonViT), 256K context.
    // Tools verified empirically 4/4 rounds against /v1/chat/completions
    // (structured tool_call + clean multi-turn follow-up) — no multi-turn-500
    // regression, unlike its kimi-k2-thinking sibling.
    //
    // Vision was false from 2026-06-25 to 2026-07-30 because the endpoint HTTP
    // 500'd on every image_url payload. Re-probed 2026-07-30 with a 512x512
    // PNG: HTTP 200 and the number + colour read correctly in 6/6 trials.
    //
    // Worth knowing WHY the old verdict was wrong, because it was not simply
    // an upstream fix: the probe's own fixture was a 64x64 PNG that Ollama's
    // decoders refuse, and this model still 500s on that image today. A dead
    // fixture reads exactly like a missing capability. The probe now sends
    // 512x512 and reports a decode refusal as its own verdict — see
    // scripts/lib/ollama-cloud-vision-probe.mjs.
    const m = TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.find((x) => x.id === "kimi-k2.7-code");
    expect(m).toBeDefined();
    expect(m!.reasoning).toBe(true);
    expect(m!.vision).toBe(true);
    expect(m!.contextWindow).toBe(262144);
    expect(VISION_OLLAMA_CLOUD_MODEL_IDS.has("kimi-k2.7-code")).toBe(true);
  });

  it("drops nemotron-3-nano:30b — tool calls now fail 3 of 4 rounds (2026-07-30)", () => {
    // Carried since 2026-06 as a fast/cheap 1M-context option. The 2026-07-30
    // sweep found it silently skipping the tool call: HTTP 200, empty content,
    // no tool_calls — qwen3-next's exact failure mode. Re-probed four more
    // times: 1 clean, 3 no-call. An agent on this model would ignore its tools
    // three turns out of four, which is worse than an outright error because it
    // looks like the model simply chose not to act.
    //
    // Intermittent, not dead — and intermittent is still disqualifying here,
    // the same bar qwen3-next was held to. Re-adding needs a clean multi-round
    // sweep, not one lucky pass.
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain("nemotron-3-nano:30b");
  });

  it("keeps kimi-k3 out — extra-usage-only billing, not plan usage (2026-07-30)", () => {
    // Appeared in /v1/models on 2026-07-30 with everything we look for on
    // ollama.com/library/kimi-k3: "vision tools thinking cloud", 1M context
    // (/api/show agrees: 1048576). It is still not a candidate, and the reason
    // is commercial rather than technical.
    //
    // Every request returns HTTP 402: "this model uses extra usage only (not
    // included plan usage) and your extra usage balance is empty". Confirmed
    // twice — through the API with a valid key and through the signed-in CLI.
    // So it cannot be capability-probed without buying balance, and more to the
    // point, surfacing it would hand Pro/Max users an agent that 402s on every
    // turn. It would also break this catalog's zero-cost premise (see
    // ZERO_COST): Ollama Cloud is subscription-billed, which is exactly why
    // Pinchy reports tokens and not spend.
    //
    // Add it only once the account carries an extra-usage balance AND the tools
    // and vision probes have run. Never from the library page alone.
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain("kimi-k3");
  });

  it("keeps the deepseek-v4 pair's context windows split: pro 512K, flash 1M", () => {
    // These two look like they should match — same family, and both library
    // pages claim 1M — but `ollama show` splits them: pro reports 524288,
    // flash 1048576. So this guards against a well-meant "fix" in either
    // direction. Rationale and the production incident behind pro's value:
    // see ollama-cloud-models.ts.
    expect(byId("deepseek-v4-pro")?.contextWindow).toBe(524288);
    expect(byId("deepseek-v4-flash")?.contextWindow).toBe(1048576);
  });

  it("caps both DeepSeek-V4 models' effective context at 128K while keeping native windows honest", () => {
    // contextWindow stays the honest native size (pro 512K, flash 1M, guarded
    // above), and a separate contextTokens field carries Pinchy's researched
    // policy cap. OpenClaw budgets compaction against contextTokens (< window,
    // resolveContextWindowInfo source "modelsConfig"), so the family's
    // long-context quality knee can't cause the silent confabulation the
    // 2026-07-15 pro incident traced to context bloat past ~170K.
    //   - pro:   ~0.92 recall @128K → ~0.66 @512K (2026-07-15 incident).
    //   - flash: DeepSeek-V4 MRCR "stable up to 128K, degradation beyond"; and
    //     Flash-Max 0.49 < Pro-Max 0.59 MRCR 8-needle @1M, i.e. weaker at long
    //     context than pro, so the same 128K knee applies a fortiori.
    const pro = byId("deepseek-v4-pro");
    expect(pro?.contextWindow).toBe(524288);
    expect(pro?.contextTokens).toBe(131072);
    const flash = byId("deepseek-v4-flash");
    expect(flash?.contextWindow).toBe(1048576);
    expect(flash?.contextTokens).toBe(131072);
  });

  it("never sets a contextTokens cap above the native contextWindow", () => {
    // The whole point of contextTokens is a budget *below* the native window,
    // which OpenClaw budgets compaction against. A cap above contextWindow is
    // nonsense OpenClaw would swallow silently, so guard every current and
    // future cap in one place — a typo on the next capped model fails here.
    // Widen off the `as const` literals so the optional field is visible (same
    // satisfies-based widening as byId, no cast).
    const models: readonly OllamaCloudModel[] = TOOL_CAPABLE_OLLAMA_CLOUD_MODELS;
    for (const m of models) {
      if (m.contextTokens !== undefined) {
        expect(m.contextTokens).toBeLessThanOrEqual(m.contextWindow);
      }
    }
  });

  it("every model declares vision and carries no dead capability fields", () => {
    for (const m of TOOL_CAPABLE_OLLAMA_CLOUD_MODELS) {
      expect(typeof m.vision).toBe("boolean");
      // documents/audio/video were deleted — PDFs route via the pdf tool and
      // audio/video are not uploadable. Pin the deletion so the dead fields
      // don't creep back in.
      expect("documents" in m).toBe(false);
      expect("audio" in m).toBe(false);
      expect("video" in m).toBe(false);
    }
  });
});
