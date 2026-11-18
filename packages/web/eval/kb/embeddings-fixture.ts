/**
 * Shared fixture type + loader for the KB eval harness's committed
 * embeddinggemma-300m embeddings (`corpus/embeddings.json`). Both `reembed.ts`
 * (the writer) and every reader — today `embeddings-drift.test.ts`, later Task
 * 1.4's Layer-1 harness — import this ONE `loadEmbeddings()` rather than
 * re-parsing the file independently, so the fixture shape is defined in exactly
 * one place.
 *
 * Why a committed fixture at all: the Layer-1 gate must be deterministic AND
 * keyless in CI. Freezing embeddinggemma embeddings removes the model from the
 * gate loop entirely — only our SQL/RRF logic is under test. Regenerating is an
 * explicit, reviewable act (`pnpm kb-eval:reembed`), never an implicit one.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Absolute path to the committed embeddings fixture. */
export const EMBEDDINGS_FIXTURE_PATH = resolve(__dirname, "corpus/embeddings.json");

/**
 * Fixture shape, fixed exactly so downstream consumers (Task 1.4's Layer 1)
 * can map cleanly:
 *
 * ```json
 * {
 *   "model": "embeddinggemma-300m",
 *   "dim": 768,
 *   "chunks": { "<chunkId>": [ ...768 floats ], ... },
 *   "queries": { "<goldQueryId>": [ ...768 floats ], ... }
 * }
 * ```
 */
export interface EmbeddingsFixture {
  /** Embedding model that produced every vector below. Expected "embeddinggemma-300m". */
  model: string;
  /** Vector width for every entry below. Expected 768 (EMBEDDING_DIMENSIONS). */
  dim: number;
  /** One embedding per `KB_EVAL_CORPUS` chunk, keyed by `chunk.id`. */
  chunks: Record<string, number[]>;
  /** One embedding per `GOLD_QUERIES` entry, keyed by `GoldQuery.id`. */
  queries: Record<string, number[]>;
}

/**
 * Loads and parses the committed embeddings fixture.
 *
 * Throws a clear, actionable error — naming the missing fixture and the
 * regeneration command — instead of letting an ENOENT or JSON.parse
 * SyntaxError bubble up as an opaque stack trace. The fixture does not exist
 * until someone with the embeddinggemma GGUF on disk runs
 * `pnpm kb-eval:reembed`, so this is the expected first failure mode for any
 * fresh checkout or CI run that hasn't generated it yet.
 */
export function loadEmbeddings(fixturePath: string = EMBEDDINGS_FIXTURE_PATH): EmbeddingsFixture {
  // `fixturePath` defaults to the committed fixture and is only overridden by
  // the loader's own unit tests, which point it at a missing path (to exercise
  // the ENOENT branch) or a deliberately-corrupt temp file (to exercise the
  // parse branch) — testing the real fs failure modes without depending on the
  // committed fixture actually being absent/corrupt on disk.
  let raw: string;
  try {
    raw = readFileSync(fixturePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `KB eval embeddings fixture not found at ${fixturePath}. ` +
          "Run `pnpm kb-eval:reembed` (requires the embeddinggemma GGUF on disk, " +
          "set KB_EMBEDDING_MODEL_PATH) to generate it."
      );
    }
    throw err;
  }

  try {
    return JSON.parse(raw) as EmbeddingsFixture;
  } catch (err) {
    throw new Error(
      `KB eval embeddings fixture at ${fixturePath} is not valid JSON. ` +
        `Delete it and re-run \`pnpm kb-eval:reembed\` to regenerate. (${(err as Error).message})`
    );
  }
}
