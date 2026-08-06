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

/**
 * Extracts the GGUF download command itself — `curl -fsSL … huggingface…gguf`.
 *
 * Anchoring on the first `curl` token would match `apt-get install … curl` and,
 * worse, would let flag text in the *explanatory comment* above the command
 * satisfy a flag assertion while the real command had lost it. The comment sits
 * before `curl -fsSL`, so it is outside this span. The command is
 * backslash-continued across lines, hence `[\s\S]` up to the HF URL.
 *
 * Throws rather than returning "" when it finds nothing: an empty string
 * satisfies every NEGATIVE assertion below vacuously, so a Dockerfile this
 * function can no longer read must be an error, not a pass.
 */
function downloadCommand(dockerfile: string): string {
  const command = dockerfile.match(/curl -fsSL[\s\S]*?huggingface\.co\S+\.gguf/)?.[0];
  if (!command) {
    throw new Error(
      "No `curl -fsSL … huggingface…gguf` download found — this guard cannot assert flags on a command it did not locate."
    );
  }
  return command;
}

/**
 * Asserts the download is willing to outlast a HuggingFace rate limit, not just
 * a single hiccup.
 *
 * On 2026-08-06 the `Pre-release` image build went red on main against HF 429s.
 * `--retry 5 --retry-all-errors --retry-delay 5` was in place and the guard
 * below was green, because it asserted the flags were PRESENT rather than what
 * they resolve to. curl's manual on the flag that did the damage:
 *
 *   "When curl is about to retry a transfer, it first waits one second and then
 *    for all forthcoming retries it doubles the waiting time … By using
 *    --retry-delay you disable this exponential backoff algorithm."
 *
 * So every attempt landed inside 25 s — six requests into a rate limit, which
 * is closer to making it worse than to riding it out. The observed timeline was
 * exactly that: 0.2s, 5.2s, 10.2s, 15.2s, 20.3s, 25.3s, all 429.
 *
 * What --retry-delay does NOT do, easy as it is to assume: it does not switch
 * off curl's Retry-After compliance. curl takes the LARGER of the computed
 * sleep and the header, so Retry-After is honoured either way — measured
 * against curl 8.x with a 429-serving stub, not inferred. Which means the even
 * 5 s spacing above is itself the evidence that HF sent no usable Retry-After,
 * and restored exponential backoff is the entire fix.
 *
 * This is the same failure shape as the X-Frame-Options gate documented in
 * AGENTS.md — assert the behaviour a command resolves to, not the flag a file
 * asked for.
 */
function expectPatientBackoff(download: string): void {
  // A fixed delay is the specific thing that broke it: it switches off the
  // exponential backoff and leaves every retry evenly spaced.
  expect(download).not.toMatch(/--retry-delay/);

  // Without the fixed delay, backoff doubles 1,2,4,8,… so the retry COUNT is
  // what buys patience: 8 retries sleep ~255s in total, 5 would sleep ~31s and
  // land back where this started.
  const retries = Number(download.match(/--retry\s+(\d+)/)?.[1]);
  expect(retries).toBeGreaterThanOrEqual(8);

  // …and the count alone is unbounded upward once doubling passes a minute, so
  // bound how long curl may keep STARTING retries. That is what
  // --retry-max-time caps — not the total wall clock, and not a transfer
  // already in flight. This is the number to argue about if it ever needs
  // changing; it is deliberately long enough to ride out a rate limit (8
  // retries sleep ~255s, comfortably inside 300) and short enough that a
  // genuinely gone upstream fails the same afternoon rather than occupying a
  // runner.
  const maxTime = Number(download.match(/--retry-max-time\s+(\d+)/)?.[1]);
  expect(maxTime).toBeGreaterThanOrEqual(300);
}

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
    const download = downloadCommand(DOCKERFILE_OPENCLAW);
    expect(download).toMatch(/--retry\s+\d+/);
    expect(download).toMatch(/--retry-all-errors/);
  });

  it("waits long enough for a rate limit, with backoff left switched on", () => {
    expectPatientBackoff(downloadCommand(DOCKERFILE_OPENCLAW));
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
    const download = downloadCommand(DOCKERFILE_PINCHY);
    expect(download).toMatch(/--retry\s+\d+/);
    expect(download).toMatch(/--retry-all-errors/);
  });

  it("waits long enough for a rate limit, with backoff left switched on", () => {
    expectPatientBackoff(downloadCommand(DOCKERFILE_PINCHY));
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
