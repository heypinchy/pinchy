/**
 * The knowledge base's embedder wiring: embeddinggemma-300m loaded IN-PROCESS
 * via node-llama-cpp (768-dim), never over Ollama. Both KB embedding sites (the
 * index worker and the search route) resolve their config and their
 * availability gate from here, so the "how does the KB embed" decision lives in
 * one place — and switching off the Ollama dependency (#715) also dissolved the
 * setup friction where an embedding-only deployment could not configure the KB.
 *
 * Deliberate trade-off: embedding no longer runs in a separate Ollama process
 * but IN the web process, so the ~300 MB GGUF + node-llama-cpp native runtime
 * are resident in the server that also handles requests, and a large reindex's
 * embed loop is CPU work competing with request serving on the same box. For
 * single-box self-hosting (the target deployment) that is the point — one
 * self-contained container, no side-car — and the model loads lazily on first
 * embed (getLocalEmbeddingContext), so a deployment that never uses the KB
 * pays nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_MODEL_PATH } from "./constants";
import type { EmbeddingConfig } from "./embeddings";
import { LOG_REASON_MAX, oneLine } from "@/lib/log-line";

/** node-llama-cpp's own default for an embedding context; never asked to exceed it. */
const MAX_EMBEDDING_THREADS = 6;

/**
 * How many llama.cpp threads the KB embedder gets: every CPU this container
 * may actually use, minus one, at least one and at most six.
 *
 * Why not node-llama-cpp's default of 6: llama.cpp's worker threads wait for
 * each other at a spinning barrier after every graph node, so a thread without
 * a core of its own stalls all the others until the scheduler gets round to
 * it. Measured with the bundled embeddinggemma GGUF in the production image,
 * pinned to 2 cores and capped at 1.5 CPUs like the staging VM: one query
 * embedding took 3.0-5.8 s at 4 threads and 16-24 ms at 1 thread; three
 * parallel queries took 5.8/8.7/14.1 s against 17/35/56 ms. A 512-token
 * indexing chunk took 3.3-6.2 s against 0.85-0.93 s. The spare core is for
 * everything else in the container — request serving, the database client,
 * PDF and Office extraction — which a full-width thread pool would otherwise
 * fight.
 *
 * The CPU that counts is the container's, not the host's: docker-compose.yml
 * caps pinchy at `PINCHY_CPUS` (default 1.5). Node 22's availableParallelism()
 * already folds the cgroup quota in (libuv 1.51: `--cpus=1.5` on a 14-core
 * host reports 1, where os.cpus() reports 14). `cpuQuota`, read from cgroup
 * v2's cpu.max, is a second source for a runtime that doesn't; a fractional
 * quota rounds down.
 *
 * `override` is `KB_EMBEDDING_THREADS`, for a host where neither signal is
 * right; anything but a positive integer is ignored.
 */
export function resolveEmbeddingThreads(input: {
  cpus: number;
  cpuQuota: number | null;
  override?: string;
}): number {
  if (input.override !== undefined && isValidThreadOverride(input.override)) {
    return Number(input.override.trim());
  }
  const usable =
    input.cpuQuota != null ? Math.min(input.cpus, Math.floor(input.cpuQuota)) : input.cpus;
  return Math.min(MAX_EMBEDDING_THREADS, Math.max(1, usable - 1));
}

function isValidThreadOverride(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

/**
 * A cgroup v2 `cpu.max` ("<quota> <period>", or "max <period>" for no limit)
 * as a number of CPUs, or null when there is no readable quota.
 */
export function parseCgroupCpuMax(content: string): number | null {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(content.trim());
  if (!match) return null;
  const quota = Number(match[1]);
  const period = Number(match[2]);
  if (period <= 0) return null;
  return quota / period;
}

/** The container's cgroup v2 CPU quota in CPUs, or null when there is none to read. */
export function readCpuQuota(path = "/sys/fs/cgroup/cpu.max"): number | null {
  try {
    return parseCgroupCpuMax(readFileSync(path, "utf8"));
  } catch {
    // No cgroup v2 (macOS dev, cgroup v1): fall back to the core count alone.
    return null;
  }
}

let kbEmbeddingThreads: number | undefined;

/**
 * The KB's fixed embedding config: embeddinggemma-300m via provider "local"
 * (in-process node-llama-cpp), 768-dim. `baseUrl` is required by the type but
 * unused on the local path.
 */
export function kbEmbeddingConfig(): EmbeddingConfig {
  if (kbEmbeddingThreads === undefined) {
    const override = process.env.KB_EMBEDDING_THREADS;
    kbEmbeddingThreads = resolveEmbeddingThreads({
      cpus: availableParallelism(),
      cpuQuota: readCpuQuota(),
      override,
    });
    // An operator who set it expects it to matter; say so when it doesn't —
    // once per module instance, so at most twice per process.
    if (override !== undefined && override.trim() !== "" && !isValidThreadOverride(override)) {
      console.warn(
        `[knowledge] KB_EMBEDDING_THREADS="${oneLine(override, LOG_REASON_MAX)}" is not a positive whole ` +
          `number and was ignored; the embedder uses ${kbEmbeddingThreads} thread(s).`
      );
    }
  }
  return {
    baseUrl: "",
    provider: "local",
    model: EMBEDDING_MODEL,
    modelPath: EMBEDDING_MODEL_PATH,
    expectedDim: EMBEDDING_DIMENSIONS,
    threads: kbEmbeddingThreads,
  };
}

/**
 * Is the bundled embeddinggemma GGUF present on disk? The image ships it
 * (Dockerfile.pinchy), so `false` means a broken build or mount — NOT an
 * operator choice — and the KB's ingest + search surface it as a clear error
 * instead of crashing mid-run when node-llama-cpp fails to open the file.
 */
export function kbEmbedderAvailable(): boolean {
  return existsSync(EMBEDDING_MODEL_PATH);
}
