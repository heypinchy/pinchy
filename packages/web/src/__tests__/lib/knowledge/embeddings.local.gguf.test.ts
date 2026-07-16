import { describe, it, expect } from "vitest";
import { embedTexts } from "@/lib/knowledge/embeddings";

/**
 * Exercises the real node-llama-cpp path end-to-end against a real GGUF
 * embedding model (embeddinggemma, 768-dim — deliberately decoupled from
 * the KB's 1024-dim EMBEDDING_DIMENSIONS constant, which stays bge-m3/Ollama
 * for now; see #715 for the eventual switch).
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
  }
);
