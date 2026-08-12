/**
 * Resolving the index-time OCR setup: which model, whose key, and when the
 * whole thing stays off.
 *
 * The vision call is injected (`describeImage`) rather than module-mocked, so
 * these tests exercise the real resolution path — settings lookup, provider
 * mapping, model choice — and stop exactly where the network would start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveKbOcr } from "@/lib/knowledge/kb-ocr";

vi.mock("@/lib/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/lib/openclaw-config/default-media-models", () => ({
  resolveDefaultVisionModelChain: vi.fn(),
}));

const { getSetting } = await import("@/lib/settings");
const { resolveDefaultVisionModelChain } =
  await import("@/lib/openclaw-config/default-media-models");

const mockGetSetting = vi.mocked(getSetting);
const mockChain = vi.mocked(resolveDefaultVisionModelChain);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PINCHY_KB_OCR;
  mockGetSetting.mockResolvedValue(null);
  mockChain.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.PINCHY_KB_OCR;
});

describe("when OCR cannot or should not run", () => {
  it("returns null when no vision model is configured", async () => {
    // A text-only stack. Scans then index as empty pages, which is the honest
    // degraded state — not an error, and not a reason to fail the document.
    mockChain.mockResolvedValue([]);

    expect(await resolveKbOcr()).toBeNull();
  });

  it("returns null when the operator turned it off", async () => {
    // The lever for the one thing that makes this feature a decision rather
    // than a default: with OCR on, every scanned document is sent to the
    // configured provider at index time, whether or not anyone ever asks
    // about it. An instance that must not do that sets this.
    mockChain.mockResolvedValue(["anthropic/claude-haiku-4-5-20251001"]);
    mockGetSetting.mockResolvedValue("sk-ant-test");
    process.env.PINCHY_KB_OCR = "off";

    expect(await resolveKbOcr()).toBeNull();
  });

  it("returns null when the chosen provider has no key", async () => {
    // The chain is resolved from configured providers, so this is a narrow
    // race (a key removed between resolution and use) rather than a normal
    // state — but calling a provider unauthenticated is never the answer.
    mockChain.mockResolvedValue(["anthropic/claude-haiku-4-5-20251001"]);
    mockGetSetting.mockResolvedValue(null);

    expect(await resolveKbOcr()).toBeNull();
  });
});

describe("when it runs", () => {
  it("reads a page with the resolved vision model and hands back its text", async () => {
    mockChain.mockResolvedValue(["anthropic/claude-haiku-4-5-20251001"]);
    mockGetSetting.mockResolvedValue("sk-ant-test");
    const describeImage = vi.fn().mockResolvedValue({
      text: "AFNOR VALIDATION",
      usage: { inputTokens: 900, outputTokens: 40 },
    });

    const ocr = await resolveKbOcr({ describeImage });
    const text = await ocr!.ocrPage(Buffer.from("png-bytes"));

    expect(text).toBe("AFNOR VALIDATION");
    const [imageBase64, config] = describeImage.mock.calls[0];
    expect(imageBase64).toBe(Buffer.from("png-bytes").toString("base64"));
    expect(config.model).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("reports a failed vision call as null rather than as empty text", async () => {
    // `describePageImage` returns null on a provider error. Passing that
    // through as "" would make a failed OCR indistinguishable from a page
    // that genuinely says nothing — the extractor keeps the page's own text
    // on null, and cannot do that if this flattens it.
    mockChain.mockResolvedValue(["anthropic/claude-haiku-4-5-20251001"]);
    mockGetSetting.mockResolvedValue("sk-ant-test");
    const describeImage = vi.fn().mockResolvedValue(null);

    const ocr = await resolveKbOcr({ describeImage });

    expect(await ocr!.ocrPage(Buffer.from("png"))).toBeNull();
  });

  it("resolves each provider's key from that provider's own setting", async () => {
    mockChain.mockResolvedValue(["ollama-cloud/gemini-3-flash-preview"]);
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "sk-cloud" : null
    );
    const describeImage = vi.fn().mockResolvedValue({ text: "t", usage: {} });

    const ocr = await resolveKbOcr({ describeImage });
    await ocr!.ocrPage(Buffer.from("png"));

    const config = describeImage.mock.calls[0][1];
    expect(await config.resolveApiKey("ollama-cloud")).toBe("sk-cloud");
  });

  it("refuses to resolve a key for a provider it does not know", async () => {
    // `resolveApiKey` takes the provider name parsed out of a model id. That
    // is derived data, so the lookup is an explicit allow-list rather than an
    // index into a settings object.
    mockChain.mockResolvedValue(["anthropic/claude-haiku-4-5-20251001"]);
    mockGetSetting.mockResolvedValue("sk-ant-test");
    const describeImage = vi.fn().mockResolvedValue({ text: "t", usage: {} });

    const ocr = await resolveKbOcr({ describeImage });
    await ocr!.ocrPage(Buffer.from("png"));

    const config = describeImage.mock.calls[0][1];
    expect(await config.resolveApiKey("constructor")).toBeNull();
    expect(await config.resolveApiKey("__proto__")).toBeNull();
    // ollama-local authenticates by URL and has no key to hand out.
    expect(await config.resolveApiKey("ollama-local")).toBeNull();
  });

  it("stays off on a local-only Ollama stack, because the model chain excludes it", async () => {
    // A stated limitation, pinned so it is a decision rather than a surprise.
    // `resolveVisionModelChain` deliberately omits `ollama-local` — vision
    // depends on which model the operator pulled, and the chain has no way to
    // know — so an air-gapped install has no vision model to resolve and its
    // scans stay unsearchable. Lifting that means teaching the chain about
    // locally pulled vision models, which also moves the built-in pdf/image
    // tools and is its own change.
    mockGetSetting.mockImplementation(async (key: string) =>
      key === "ollama_local_url" ? "http://host.docker.internal:11434" : null
    );
    mockChain.mockResolvedValue([]);

    expect(await resolveKbOcr()).toBeNull();
  });
});
