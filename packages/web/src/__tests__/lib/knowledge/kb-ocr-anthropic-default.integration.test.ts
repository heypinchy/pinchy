/**
 * An install whose only provider is Anthropic must read scanned documents.
 *
 * Nothing here is mocked between the provider's model list and the OCR setup:
 * the live `/v1/models` answer goes through the real default-model selection,
 * the capability table is seeded from the real curated catalog, and the vision
 * chain and `resolveKbOcr` run unmodified. Only the edges are stubbed — the key
 * lookup, the HTTP call, and the vision request itself.
 *
 * Why the whole path: each piece was correct on its own, and the chain still
 * came out empty. The default was picked from the live list, which on a real
 * Anthropic key never named a curated model (the dated, older
 * `claude-sonnet-4-5-20250929` even sorted first), so the capability table had
 * no row for it, the model read as unable to see, and Anthropic dropped out of
 * the chain — no pdf tool, and every scan indexed as an empty page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/db";
import { models } from "@/db/schema";
import { seedBuiltinModels } from "@/lib/model-capabilities/seed";
import {
  invalidateModelCapabilityCache,
  loadModelCapabilityCache,
} from "@/lib/model-capabilities/cache";
import { getDefaultModel, resetCache } from "@/lib/provider-models";
import { isModelVisionCapable } from "@/lib/model-vision";
import { resolveDefaultVisionModelChain } from "@/lib/openclaw-config/default-media-models";
import { resolveKbOcr, type ResolveKbOcrDeps } from "@/lib/knowledge/kb-ocr";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(async (key: string) => (key === "anthropic_api_key" ? "sk-ant-test" : null)),
}));

// GET /v1/models on an Anthropic key in October 2026, newest first, as the API
// lists them. Dateless ids start with the 4.6 generation; the dated ones are
// older snapshots.
const ANTHROPIC_MODELS_RESPONSE = {
  data: [
    { id: "claude-fable-5-1", display_name: "Claude Fable 5.1" },
    { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
    { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
    { id: "claude-fable-5", display_name: "Claude Fable 5" },
    { id: "claude-opus-5", display_name: "Claude Opus 5" },
    { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
  ],
};

beforeEach(async () => {
  resetCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith("/v1/models")) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(ANTHROPIC_MODELS_RESPONSE), { status: 200 });
    })
  );
  await db.delete(models);
  await seedBuiltinModels();
  invalidateModelCapabilityCache();
  await loadModelCapabilityCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCache();
});

describe("Anthropic-only install, real model list", () => {
  it("defaults to a model the capability catalog knows can see", async () => {
    const model = await getDefaultModel("anthropic");

    expect(model).toBe("anthropic/claude-sonnet-5");
    expect(isModelVisionCapable(model)).toBe(true);
  });

  it("routes PDF and image reading to Anthropic", async () => {
    expect(await resolveDefaultVisionModelChain()).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("turns knowledge-base OCR on, reading scans with that model and key", async () => {
    const describeImage = vi.fn<NonNullable<ResolveKbOcrDeps["describeImage"]>>(async () => ({
      text: "Werkszeugnis 3.1 nach EN 10204",
      usage: { inputTokens: 1500, outputTokens: 40 },
    }));

    const ocr = await resolveKbOcr({ describeImage });

    expect(ocr).not.toBeNull();
    expect(ocr!.model).toBe("anthropic/claude-sonnet-5");
    expect(await ocr!.ocrPage(Buffer.from("png"))).toBe("Werkszeugnis 3.1 nach EN 10204");
    const config = describeImage.mock.calls[0][1];
    expect(config.model).toBe("anthropic/claude-sonnet-5");
    expect(await config.resolveApiKey("anthropic")).toBe("sk-ant-test");
  });
});
