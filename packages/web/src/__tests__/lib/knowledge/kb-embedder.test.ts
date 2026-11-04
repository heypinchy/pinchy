import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  kbEmbeddingConfig,
  parseCgroupCpuMax,
  resolveEmbeddingThreads,
} from "@/lib/knowledge/kb-embedder";
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

  it("carries a thread count sized for this machine", () => {
    const { threads } = kbEmbeddingConfig();

    expect(Number.isInteger(threads)).toBe(true);
    expect(threads).toBeGreaterThanOrEqual(1);
  });

  it("takes the thread count from KB_EMBEDDING_THREADS when an operator sets it", async () => {
    const orig = process.env.KB_EMBEDDING_THREADS;
    process.env.KB_EMBEDDING_THREADS = "3";
    vi.resetModules();
    try {
      const { kbEmbeddingConfig: fresh } = await import("@/lib/knowledge/kb-embedder");
      expect(fresh().threads).toBe(3);
    } finally {
      if (orig === undefined) delete process.env.KB_EMBEDDING_THREADS;
      else process.env.KB_EMBEDDING_THREADS = orig;
      vi.resetModules();
    }
  });
});

// llama.cpp's worker threads spin at a barrier between graph nodes, so a thread
// that has no core to run on stalls every other one. node-llama-cpp's embedding
// context asks for 6 threads. On the staging VM (2 vCPUs, and the pinchy
// container capped at 1.5 CPUs by docker-compose.yml) that made one query
// embedding take 3-6 s instead of ~15 ms, and three parallel knowledge_search
// calls queue behind one another until the third hits the plugin's 10 s timeout.
describe("resolveEmbeddingThreads", () => {
  it("leaves a core free for Postgres and request serving on a 2-vCPU box", () => {
    expect(resolveEmbeddingThreads({ cpus: 2, cpuQuota: null })).toBe(1);
  });

  it("honours the container's CPU quota even when the core count ignores it", () => {
    // docker-compose.yml's default `cpus: 1.5` on the 2-vCPU staging VM.
    expect(resolveEmbeddingThreads({ cpus: 2, cpuQuota: 1.5 })).toBe(1);
    // Same quota on a big host, read by a runtime whose core count ignores it.
    expect(resolveEmbeddingThreads({ cpus: 14, cpuQuota: 1.5 })).toBe(1);
    expect(resolveEmbeddingThreads({ cpus: 16, cpuQuota: 4 })).toBe(3);
  });

  it("uses all but one core on a mid-sized box", () => {
    expect(resolveEmbeddingThreads({ cpus: 4, cpuQuota: null })).toBe(3);
  });

  it("never asks for more than node-llama-cpp's own default of 6", () => {
    expect(resolveEmbeddingThreads({ cpus: 32, cpuQuota: null })).toBe(6);
  });

  it("never goes below one thread", () => {
    expect(resolveEmbeddingThreads({ cpus: 1, cpuQuota: null })).toBe(1);
    expect(resolveEmbeddingThreads({ cpus: 1, cpuQuota: 0.5 })).toBe(1);
  });

  it("lets an operator override the choice with a positive integer", () => {
    expect(resolveEmbeddingThreads({ cpus: 2, cpuQuota: 1.5, override: "2" })).toBe(2);
  });

  it("ignores an override that is not a positive integer", () => {
    for (const override of ["", "0", "-1", "1.5", "two", "3x"]) {
      expect(resolveEmbeddingThreads({ cpus: 4, cpuQuota: null, override })).toBe(3);
    }
  });
});

describe("parseCgroupCpuMax", () => {
  it("reads a cgroup v2 quota as CPUs", () => {
    expect(parseCgroupCpuMax("150000 100000\n")).toBe(1.5);
    expect(parseCgroupCpuMax("200000 100000")).toBe(2);
  });

  it("returns null when there is no quota", () => {
    expect(parseCgroupCpuMax("max 100000\n")).toBeNull();
  });

  it("returns null for anything it cannot read", () => {
    expect(parseCgroupCpuMax("")).toBeNull();
    expect(parseCgroupCpuMax("garbage")).toBeNull();
    expect(parseCgroupCpuMax("150000 0")).toBeNull();
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
