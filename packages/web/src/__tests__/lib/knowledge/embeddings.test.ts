import { describe, it, expect, vi, beforeEach } from "vitest";
import { embedTexts } from "@/lib/knowledge/embeddings";

global.fetch = vi.fn();

// node-llama-cpp is mocked so the fast unit suite never loads the native
// addon. embedTexts() must import it lazily (inside embedTextsLocal), never
// at module top-level, otherwise this mock would need to apply to every test
// file that transitively imports embeddings.ts (including Ollama-only routes).
const getEmbeddingFor = vi.fn();
const createEmbeddingContext = vi.fn();
const loadModel = vi.fn();
const getLlama = vi.fn();

vi.mock("node-llama-cpp", () => ({
  getLlama: (...args: unknown[]) => getLlama(...args),
}));

describe("embedTexts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls Ollama's batch embeddings endpoint with the input array and returns number[][]", async () => {
    const embeddings = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ];
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings }), { status: 200 })
    );

    const result = await embedTexts(["hallo", "welt"], { baseUrl: "http://ollama:11434" });

    expect(fetch).toHaveBeenCalledWith(
      "http://ollama:11434/api/embed",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/json" }),
        body: JSON.stringify({
          model: "bge-m3",
          input: ["hallo", "welt"],
          keep_alive: -1,
        }),
      })
    );
    expect(result).toEqual(embeddings);
  });

  it("defaults to the bge-m3 model and strips a trailing slash from baseUrl", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 })
    );

    await embedTexts(["hallo"], { baseUrl: "http://ollama:11434/" });

    expect(fetch).toHaveBeenCalledWith(
      "http://ollama:11434/api/embed",
      expect.objectContaining({
        body: JSON.stringify({ model: "bge-m3", input: ["hallo"], keep_alive: -1 }),
      })
    );
  });

  it("pins the model resident (keep_alive: -1) by default so it never idle-unloads", async () => {
    // Ollama's default keep_alive is 5m. The first KB query after idle then
    // hits a ~25s cold model load, knowledge_search errors out, and the
    // agent wrongly reports the knowledge base as empty. Pinning keep_alive
    // to -1 (forever resident) prevents that cold start.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 })
    );

    await embedTexts(["hallo"], { baseUrl: "http://ollama:11434" });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.keep_alive).toBe(-1);
  });

  it("uses a caller-provided keepAlive instead of the -1 default", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 })
    );

    await embedTexts(["hallo"], { baseUrl: "http://ollama:11434", keepAlive: "30m" });

    expect(fetch).toHaveBeenCalledWith(
      "http://ollama:11434/api/embed",
      expect.objectContaining({
        body: JSON.stringify({ model: "bge-m3", input: ["hallo"], keep_alive: "30m" }),
      })
    );
  });

  it("does not attach an Authorization header for the local ollama provider", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 })
    );

    await embedTexts(["hallo"], {
      baseUrl: "http://ollama:11434",
      provider: "ollama",
      apiKey: "unused",
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("attaches a Bearer Authorization header for a non-ollama provider with an API key", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 })
    );

    await embedTexts(["hallo"], {
      baseUrl: "https://ollama.example.com",
      provider: "ollama-cloud",
      apiKey: "test-key",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://ollama.example.com/api/embed",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      })
    );
  });

  it("throws with a useful message on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("model not found", { status: 404 }));

    await expect(embedTexts(["hallo"], { baseUrl: "http://ollama:11434" })).rejects.toThrow(/404/);
  });

  it("throws on a malformed response missing the embeddings array", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ oops: true }), { status: 200 })
    );

    await expect(embedTexts(["hallo"], { baseUrl: "http://ollama:11434" })).rejects.toThrow(
      /malformed/i
    );
  });

  it("throws when the returned vectors have inconsistent dimensions", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          embeddings: [
            [1, 2, 3],
            [1, 2],
          ],
        }),
        { status: 200 }
      )
    );

    await expect(embedTexts(["hallo", "welt"], { baseUrl: "http://ollama:11434" })).rejects.toThrow(
      /dimension/i
    );
  });

  it("throws a clear error when expectedDim is set and the returned width does not match", async () => {
    // The KB pipeline pins bge-m3's 1024 dims; a misconfigured model (e.g. a
    // 768-dim embedder) otherwise only surfaces as an opaque vector(1024)
    // insert failure at the DB. expectedDim turns that into a clear,
    // source-of-truth error naming both the expected and actual width.
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 })
    );

    await expect(
      embedTexts(["hallo"], { baseUrl: "http://ollama:11434", expectedDim: 1024 })
    ).rejects.toThrow(/expected 1024.*got 3|1024/i);
  });

  it("does not enforce a dimension when expectedDim is unset (client stays model-agnostic)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), { status: 200 })
    );

    await expect(embedTexts(["hallo"], { baseUrl: "http://ollama:11434" })).resolves.toEqual([
      [1, 2, 3],
    ]);
  });

  // Ingest embeds a whole document's chunks in ONE embedTexts() call
  // (ingest.ts: `deps.embed(chunks.map(c => c.text))`). A large PDF produces
  // hundreds of chunks; sending them all in a single unbounded POST is what
  // took the reindex down at document 117 (a 342-page PDF) with `fetch failed`.
  // embedTexts must split the input into bounded, sequential requests.
  it("splits a large input into sequential batches of at most batchSize and concatenates in order", async () => {
    // Echo each input's length as a length-1 vector so order is verifiable.
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const embeddings = (body.input as string[]).map((t) => [t.length]);
      return new Response(JSON.stringify({ embeddings }), { status: 200 });
    });

    const result = await embedTexts(["a", "bb", "ccc", "dddd", "eeeee"], {
      baseUrl: "http://ollama:11434",
      batchSize: 2,
    });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(3); // ceil(5 / 2)
    const inputsPerCall = calls.map(
      ([, init]) => JSON.parse((init?.body as string) ?? "{}").input as string[]
    );
    expect(inputsPerCall).toEqual([["a", "bb"], ["ccc", "dddd"], ["eeeee"]]);
    expect(inputsPerCall.every((input) => input.length <= 2)).toBe(true);
    // Concatenated in the original order, not per-batch-scrambled.
    expect(result).toEqual([[1], [2], [3], [4], [5]]);
  });

  it("caps the batch size by default instead of sending one unbounded request", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const embeddings = (body.input as string[]).map(() => [1]);
      return new Response(JSON.stringify({ embeddings }), { status: 200 });
    });

    const texts = Array.from({ length: 200 }, (_, i) => `chunk-${i}`);
    const result = await embedTexts(texts, { baseUrl: "http://ollama:11434" });

    const calls = vi.mocked(fetch).mock.calls;
    // Pins the default (32): a change to it is a deliberate one-line edit here,
    // not a silent widening. 200 inputs => ceil(200 / 32) = 7 requests.
    expect(calls).toHaveLength(7);
    for (const [, init] of calls) {
      const input = JSON.parse((init?.body as string) ?? "{}").input as string[];
      expect(input.length).toBeLessThanOrEqual(32);
    }
    expect(result).toHaveLength(200);
  });

  it("returns [] without calling fetch for an empty input", async () => {
    await expect(embedTexts([], { baseUrl: "http://ollama:11434" })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a stalled request and throws a clear timeout error instead of hanging forever", async () => {
    // A wedged Ollama connection otherwise stalls the whole reindex with no
    // upper bound. embedTexts must pass an AbortSignal and surface the abort
    // as a timeout error, not a silent hang.
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        })
    );

    await expect(
      embedTexts(["hallo"], { baseUrl: "http://ollama:11434", timeoutMs: 20 })
    ).rejects.toThrow(/timed out/i);

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("embedTexts (provider: local, node-llama-cpp mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Wire the getLlama() -> loadModel() -> createEmbeddingContext() chain
    // back up after clearAllMocks() wipes implementations set below.
    getLlama.mockResolvedValue({ loadModel });
    loadModel.mockResolvedValue({ createEmbeddingContext });
    createEmbeddingContext.mockResolvedValue({ getEmbeddingFor });
  });

  it("embeds via node-llama-cpp and returns number[][]", async () => {
    getEmbeddingFor.mockImplementation(async () => ({ vector: [0.1, 0.2, 0.3] }));

    const result = await embedTexts(["hallo", "welt"], {
      baseUrl: "unused",
      provider: "local",
      modelPath: "/models/embed-1.gguf",
    });

    expect(result).toEqual([
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 0.3],
    ]);
    expect(getEmbeddingFor).toHaveBeenCalledTimes(2);
    expect(getEmbeddingFor).toHaveBeenCalledWith("hallo");
    expect(getEmbeddingFor).toHaveBeenCalledWith("welt");
  });

  it("throws a clear error naming modelPath when it is missing, without importing node-llama-cpp", async () => {
    await expect(embedTexts(["hallo"], { baseUrl: "unused", provider: "local" })).rejects.toThrow(
      /modelPath/
    );

    expect(getLlama).not.toHaveBeenCalled();
  });

  it("throws the same expectedDim error the Ollama path throws when node-llama-cpp returns a mismatched width", async () => {
    // Proves assertEmbeddingShape is actually shared between the two
    // backends rather than duplicated with drifting messages.
    getEmbeddingFor.mockResolvedValue({ vector: [1, 2, 3] });

    await expect(
      embedTexts(["hallo"], {
        baseUrl: "unused",
        provider: "local",
        modelPath: "/models/embed-2.gguf",
        expectedDim: 1024,
      })
    ).rejects.toThrow(/expected 1024.*got 3|1024/i);
  });

  it("loads the model once and reuses it across multiple embedTexts calls with the same modelPath", async () => {
    getEmbeddingFor.mockResolvedValue({ vector: [1, 2, 3] });
    const modelPath = "/models/embed-singleton.gguf";

    await embedTexts(["a"], { baseUrl: "unused", provider: "local", modelPath });
    await embedTexts(["b"], { baseUrl: "unused", provider: "local", modelPath });

    expect(getLlama).toHaveBeenCalledTimes(1);
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(createEmbeddingContext).toHaveBeenCalledTimes(1);
    expect(getEmbeddingFor).toHaveBeenCalledTimes(2);
  });
});
