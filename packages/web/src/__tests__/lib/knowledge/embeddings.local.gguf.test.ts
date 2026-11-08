import { describe, it, expect } from "vitest";
import { embedTexts, fitTextsForEmbedding } from "@/lib/knowledge/embeddings";

/**
 * Exercises the real node-llama-cpp path end-to-end against a real GGUF
 * embedding model (embeddinggemma, 768-dim — the KB's production embedder
 * since #715: EMBEDDING_DIMENSIONS is 768 and the index worker + search route
 * embed in-process via this same node-llama-cpp path, no Ollama).
 *
 * Gated with describe.skipIf (not an untracked test.skip — an allowed
 * env/OS conditional gate per AGENTS.md) so CI and contributors without the
 * multi-hundred-MB model file locally skip cleanly instead of failing.
 *
 * Set KB_EMBED_GGUF_PATH to a local GGUF file to run this, e.g.:
 *   npx --yes node-llama-cpp pull --dir <dir> \
 *     "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"
 *   KB_EMBED_GGUF_PATH=<dir>/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf \
 *     npx vitest run src/__tests__/lib/knowledge/embeddings.local.gguf.test.ts
 */
describe.skipIf(!process.env.KB_EMBED_GGUF_PATH)(
  "embedTexts (provider: local, real node-llama-cpp + GGUF)",
  () => {
    function cosineSimilarity(a: number[], b: number[]): number {
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    it("embeds German and English text via a real GGUF model and is cross-lingually grounded", async () => {
      const modelPath = process.env.KB_EMBED_GGUF_PATH as string;

      const [deQuery, enRelevant, enUnrelated] = await embedTexts(
        [
          "Wie kündige ich meinen Vertrag?",
          "How do I cancel my subscription?",
          "The weather in Berlin is sunny today.",
        ],
        { baseUrl: "unused", provider: "local", modelPath, expectedDim: 768 }
      );

      for (const vec of [deQuery, enRelevant, enUnrelated]) {
        expect(vec).toHaveLength(768);
        for (const value of vec) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }

      const simRelevant = cosineSimilarity(deQuery, enRelevant);
      const simUnrelated = cosineSimilarity(deQuery, enUnrelated);

      // eslint-disable-next-line no-console
      console.log(
        `[kb-embed-local] dim=${deQuery.length} cos(DE-query, EN-relevant)=${simRelevant.toFixed(4)} ` +
          `cos(DE-query, EN-unrelated)=${simUnrelated.toFixed(4)}`
      );

      expect(simRelevant).toBeGreaterThan(simUnrelated);
    }, 60_000);

    it("splits a text the model cannot take in one piece into pieces it embeds (#1380)", async () => {
      const cfg = {
        baseUrl: "unused",
        provider: "local" as const,
        modelPath: process.env.KB_EMBED_GGUF_PATH as string,
        expectedDim: 768,
      };
      // A number-dense table row costs far more tokens than characters suggest,
      // which is how a chunk inside the character budget outgrew the context.
      const dense = Array.from({ length: 1500 }, (_, i) => `${1000 + i},${i % 97}.${i % 13}`).join(
        " | "
      );

      await expect(embedTexts([dense], cfg)).rejects.toThrow(/longer than the context size/);

      const [pieces] = await fitTextsForEmbedding([dense], cfg);
      expect(pieces.length).toBeGreaterThan(1);
      const vectors = await embedTexts(pieces, cfg);
      expect(vectors).toHaveLength(pieces.length);
      for (const vec of vectors) expect(vec).toHaveLength(768);
    }, 120_000);

    // The context takes this text whole, but its batch does not: decoded in
    // several calls, the vector would reflect only the last batch, so the head
    // of the text would be missing from its own embedding (#1380).
    it("splits a text the context takes but the batch does not", async () => {
      const cfg = {
        baseUrl: "unused",
        provider: "local" as const,
        modelPath: process.env.KB_EMBED_GGUF_PATH as string,
        expectedDim: 768,
      };
      const prose =
        "The quarterly maintenance report lists every pump inspected this month. ".repeat(60);

      await expect(embedTexts([prose], cfg)).resolves.toHaveLength(1);
      const [pieces] = await fitTextsForEmbedding([prose], cfg);
      expect(pieces.length).toBeGreaterThan(1);
    }, 120_000);
  }
);
