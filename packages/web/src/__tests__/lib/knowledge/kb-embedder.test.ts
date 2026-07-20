import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { kbEmbeddingConfig } from "@/lib/knowledge/kb-embedder";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_PATH,
} from "@/lib/knowledge/constants";

describe("kbEmbeddingConfig", () => {
  it("is the in-process native embeddinggemma config: provider local, 768-dim, bundled GGUF, no network", () => {
    const cfg = kbEmbeddingConfig();

    expect(cfg.provider).toBe("local");
    expect(cfg.modelPath).toBe(EMBEDDING_MODEL_PATH);
    expect(cfg.model).toBe(EMBEDDING_MODEL);
    // The width is asserted both absolutely (768) and against the constant, so
    // a future dimension change to the column/model that forgets the config
    // fails here rather than as an opaque vector-mismatch at insert time.
    expect(cfg.expectedDim).toBe(768);
    expect(cfg.expectedDim).toBe(EMBEDDING_DIMENSIONS);
    // No Ollama endpoint: the KB embeds itself in-process.
    expect(cfg.baseUrl).toBe("");
  });
});

// kbEmbedderAvailable is a real existsSync against the (env-overridable) model
// path. Exercised against actual files — the path is read at module load, so
// each case sets the env, resets modules, and re-imports for a fresh read.
describe("kbEmbedderAvailable", () => {
  const origPath = process.env.KB_EMBEDDING_MODEL_PATH;

  afterEach(() => {
    if (origPath === undefined) delete process.env.KB_EMBEDDING_MODEL_PATH;
    else process.env.KB_EMBEDDING_MODEL_PATH = origPath;
    vi.resetModules();
  });

  it("is true when the bundled GGUF exists on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-embedder-test-"));
    const modelFile = join(dir, "embeddinggemma.gguf");
    writeFileSync(modelFile, "fake-gguf-bytes");
    process.env.KB_EMBEDDING_MODEL_PATH = modelFile;
    vi.resetModules();
    try {
      const { kbEmbedderAvailable } = await import("@/lib/knowledge/kb-embedder");
      expect(kbEmbedderAvailable()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is false when the bundled GGUF is missing (a broken image/mount, not a config choice)", async () => {
    process.env.KB_EMBEDDING_MODEL_PATH = join(tmpdir(), "kb-embedder-does-not-exist.gguf");
    vi.resetModules();
    const { kbEmbedderAvailable } = await import("@/lib/knowledge/kb-embedder");
    expect(kbEmbedderAvailable()).toBe(false);
  });
});
