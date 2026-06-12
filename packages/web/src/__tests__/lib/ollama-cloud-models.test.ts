import { describe, it, expect } from "vitest";
import {
  TOOL_CAPABLE_OLLAMA_CLOUD_MODELS,
  TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS,
  VISION_OLLAMA_CLOUD_MODEL_IDS,
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
const byId = (id: string) => TOOL_CAPABLE_OLLAMA_CLOUD_MODELS.find((m) => m.id === id);

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

  it("flags qwen3.5:397b as text-only despite its library page", () => {
    // The /v1/chat/completions endpoint returns HTTP 200 on image payloads
    // for this model but hallucinates the contents (colors 1/3, numbers 0/3
    // across distinct test images) — it does not actually see the image.
    // Unlike qwen3-vl, qwen3.5 is a text/reasoning model, not a VL model.
    // Flagged vision:false so it is never picked as an image model and is
    // not offered as a vision-capable choice.
    const m = byId("qwen3.5:397b");
    expect(m).toBeDefined();
    expect(m!.vision).toBe(false);
    expect(VISION_OLLAMA_CLOUD_MODEL_IDS.has("qwen3.5:397b")).toBe(false);
  });

  it("drops qwen3-next:80b — no working tool calls on Ollama Cloud", () => {
    // The model is still returned by /v1/models, but on the OpenAI-completions
    // endpoint OpenClaw uses it never emits a structured tool_call: it returns
    // empty content or leaks a malformed `<tools> {…} </tools>` text blob with
    // a mangled tool name, even with tool_choice:"required". Every Pinchy agent
    // uses tools (files/context/docs), so a tool-broken model must not be
    // surfaced as tool-capable.
    expect(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS).not.toContain("qwen3-next:80b");
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
