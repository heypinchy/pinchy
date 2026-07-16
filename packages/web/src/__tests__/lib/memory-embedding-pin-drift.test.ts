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

const REPO_ROOT = resolve(__dirname, "../../../../..");
const DOCKERFILE_OPENCLAW = readFileSync(resolve(REPO_ROOT, "Dockerfile.openclaw"), "utf8");
const VERIFY_SCRIPT = readFileSync(resolve(REPO_ROOT, "config/verify-memory-search.sh"), "utf8");

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
