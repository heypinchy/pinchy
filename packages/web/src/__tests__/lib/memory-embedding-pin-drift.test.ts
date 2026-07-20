/**
 * Drift guard for the bundled local memory-search embedding model.
 *
 * The `local` embedding provider that makes memory_search work offline has its
 * wiring spread across three files that MUST agree on one thing — the path of
 * the bundled GGUF model:
 *
 *   1. `Dockerfile.openclaw` — `curl -o <path> …embeddinggemma…gguf` bakes the
 *      model into the image, and `openclaw plugins install …llama-cpp-provider`
 *      installs the provider that reads it.
 *   2. `openclaw-config/build.ts` — `MEMORY_EMBEDDING_MODEL_PATH` is written into
 *      every agent's `memorySearch.local.modelPath`, i.e. the path OpenClaw
 *      actually loads at runtime.
 *   3. `config/verify-memory-search.sh` — the offline CI smoke test asserts the
 *      whole chain against the real image.
 *
 * If (1) and (2) drift, memory_search silently loads nothing in production
 * (0 chunks) while every unit test still passes — the exact silent-failure class
 * this feature exists to kill. If (3) drifts, the smoke test tests the wrong
 * file. Structural check so drift trips here at `pnpm test`, not in prod.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEMORY_EMBEDDING_MODEL_PATH } from "@/lib/openclaw-config";
import { EMBEDDING_MODEL_PATH } from "@/lib/knowledge/constants";

const REPO_ROOT = resolve(__dirname, "../../../../..");
const DOCKERFILE_OPENCLAW = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");
const DOCKERFILE_PINCHY = readFileSync(resolve(REPO_ROOT, "Dockerfile.pinchy"), "utf8");
const VERIFY_SCRIPT = readFileSync(resolve(REPO_ROOT, "config/verify-memory-search.sh"), "utf8");

/** Extracts the pinned HF `resolve/<40-hex-sha>/…gguf` revision from a Dockerfile's download URL. */
function ggufRevision(dockerfile: string): string | undefined {
  return dockerfile.match(/huggingface\.co\/\S+\/resolve\/([0-9a-f]{40})\/\S+\.gguf/)?.[1];
}

/** Extracts the pinned `sha256sum -c` digest a Dockerfile verifies the GGUF against. */
function ggufSha256(dockerfile: string): string | undefined {
  return dockerfile.match(/([0-9a-f]{64})\s+\S+\.gguf/)?.[1];
}

describe("memory embedding pin drift guard", () => {
  it("Dockerfile.openclaw installs the external llama-cpp embedding provider", () => {
    // build.ts pins memorySearch.provider = "local" and adds `llama-cpp` to
    // plugins.allow; that provider only exists in the image if it's installed.
    expect(DOCKERFILE_OPENCLAW).toMatch(/openclaw plugins install @openclaw\/llama-cpp-provider/);
  });

  it("Dockerfile downloads the GGUF to exactly MEMORY_EMBEDDING_MODEL_PATH", () => {
    // The file Pinchy points memorySearch.local.modelPath at MUST be the file
    // the image bakes, or memory_search loads nothing while unit tests pass.
    const downloaded = DOCKERFILE_OPENCLAW.match(/-o\s+(\S+\.gguf)/)?.[1];
    expect(downloaded).toBe(MEMORY_EMBEDDING_MODEL_PATH);
  });

  it("pins the GGUF download to an immutable commit revision, not a moving ref", () => {
    // `resolve/main/…` is a moving ref: upstream can replace or rename the file
    // and the image silently changes (or the build breaks). Everything else in
    // this repo is pinned (openclaw@<version>, marketplace version) — the model
    // must be too. HuggingFace serves revision-pinned URLs at resolve/<sha>/.
    expect(DOCKERFILE_OPENCLAW).not.toMatch(/huggingface\.co\/\S+\/resolve\/main\//);
    expect(DOCKERFILE_OPENCLAW).toMatch(/huggingface\.co\/\S+\/resolve\/[0-9a-f]{40}\/\S+\.gguf/);
  });

  it("verifies the downloaded GGUF against a sha256 checksum", () => {
    // No integrity check means a corrupt or tampered 329 MB download is baked
    // into the image that ships to every deployment. `sha256sum -c` fails the
    // build LOUD instead. Pin the expected digest next to the download.
    expect(DOCKERFILE_OPENCLAW).toMatch(/sha256sum\s+-c/);
    expect(DOCKERFILE_OPENCLAW).toMatch(/[0-9a-f]{64}\s+\S+\.gguf/);
  });

  it("retries the GGUF download on transient HTTP failures", () => {
    // A single HuggingFace 504 must not turn an unrelated PR red: the download
    // is a ~300 MB blob with no cache, so curl's retry is the only thing between
    // a passing build and a flaky-red one (PR #768 fell over twice this way on
    // 2026-07-16). --retry already covers the transient HTTP codes (incl. 504);
    // --retry-all-errors widens that to 4xx / non-HTTP errors as a safety net.
    //
    // Anchor on the actual download command — `curl -fsSL … huggingface…gguf` —
    // NOT on the first `curl` token (that's `apt-get install … curl`). Anchoring
    // loosely would let the flag text in the *explanatory comment* above satisfy
    // these assertions and mask a real removal of the flags from the command. The
    // comment sits before `curl -fsSL`, so it is outside this span. The curl is
    // backslash-continued across lines, hence [\s\S] up to the HF URL.
    const download =
      DOCKERFILE_OPENCLAW.match(/curl -fsSL[\s\S]*?huggingface\.co\S+\.gguf/)?.[0] ?? "";
    expect(download).toMatch(/--retry\s+\d+/);
    expect(download).toMatch(/--retry-all-errors/);
  });

  it("the CI smoke test checks the same model path", () => {
    const smokePath = VERIFY_SCRIPT.match(/MODEL_PATH="([^"]+\.gguf)"/)?.[1];
    expect(smokePath).toBe(MEMORY_EMBEDDING_MODEL_PATH);
  });
});

/**
 * Sibling guard for the knowledge base's embedder (#715). The KB embeds
 * in-process via node-llama-cpp too, but the web process it runs in ships in
 * Dockerfile.pinchy — a DIFFERENT image from the OpenClaw one above. That
 * container split is the whole migration cost: if Dockerfile.pinchy stops
 * bundling the GGUF, or bundles it at the wrong path, the KB index worker +
 * search route load nothing in production (every search returns an empty
 * corpus) while every unit test here still passes — the same silent-failure
 * class the memory guard exists to kill, one image over.
 *
 * Both features load the IDENTICAL GGUF, so the two Dockerfiles must pin the
 * same revision + checksum: a lockstep assertion, not two independent pins.
 */
describe("KB embedding pin drift guard", () => {
  it("Dockerfile.pinchy downloads the GGUF to exactly EMBEDDING_MODEL_PATH", () => {
    // The file kbEmbeddingConfig() points modelPath at MUST be the file the
    // image bakes, or the KB embeds nothing while unit tests pass.
    const downloaded = DOCKERFILE_PINCHY.match(/-o\s+(\S+\.gguf)/)?.[1];
    expect(downloaded).toBe(EMBEDDING_MODEL_PATH);
  });

  it("copies the bundled model into the runtime image", () => {
    // Downloading it in a build stage is useless unless the runtime stage — the
    // image that actually boots the web process — copies it in.
    expect(DOCKERFILE_PINCHY).toMatch(/COPY --from=embedding-model \S*\/opt\/embedding-models/);
  });

  it("pins the GGUF download to an immutable commit revision, not a moving ref", () => {
    expect(DOCKERFILE_PINCHY).not.toMatch(/huggingface\.co\/\S+\/resolve\/main\//);
    expect(DOCKERFILE_PINCHY).toMatch(/huggingface\.co\/\S+\/resolve\/[0-9a-f]{40}\/\S+\.gguf/);
  });

  it("verifies the downloaded GGUF against a sha256 checksum", () => {
    expect(DOCKERFILE_PINCHY).toMatch(/sha256sum\s+-c/);
    expect(DOCKERFILE_PINCHY).toMatch(/[0-9a-f]{64}\s+\S+\.gguf/);
  });

  it("retries the GGUF download on transient HTTP failures", () => {
    const download =
      DOCKERFILE_PINCHY.match(/curl -fsSL[\s\S]*?huggingface\.co\S+\.gguf/)?.[0] ?? "";
    expect(download).toMatch(/--retry\s+\d+/);
    expect(download).toMatch(/--retry-all-errors/);
  });

  it("pins the SAME revision + checksum as the agent-memory model (both load the identical GGUF)", () => {
    // The KB and agent-memory bundle the same embeddinggemma file. If one pin
    // moves and the other does not, the two images ship different model bytes
    // for what is meant to be one model — bump them together or not at all.
    const openclawRev = ggufRevision(DOCKERFILE_OPENCLAW);
    const pinchyRev = ggufRevision(DOCKERFILE_PINCHY);
    expect(pinchyRev).toBeDefined();
    expect(pinchyRev).toBe(openclawRev);

    const openclawSha = ggufSha256(DOCKERFILE_OPENCLAW);
    const pinchySha = ggufSha256(DOCKERFILE_PINCHY);
    expect(pinchySha).toBeDefined();
    expect(pinchySha).toBe(openclawSha);
  });
});
