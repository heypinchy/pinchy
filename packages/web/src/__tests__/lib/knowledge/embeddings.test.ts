import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EmbedderUnavailableError,
  embedTexts,
  fitTextsForEmbedding,
  LOCAL_MODEL_RETRY_COOLDOWN_MS,
  splitToTokenBudget,
  type EmbeddingTokenizer,
} from "@/lib/knowledge/embeddings";
import { locatePassage } from "@/lib/knowledge/passage-match";

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

  it("times out when the response body read stalls, not only the initial fetch", async () => {
    // A connection can wedge *after* the response headers arrive — fetch()
    // resolves, but response.json() then never settles. If the timeout only
    // covered fetch(), that stall would hang the reindex forever. The abort
    // must stay armed through the body read.
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted", "AbortError"));
            });
          }),
      } as unknown as Response;
    });

    await expect(
      embedTexts(["hallo"], { baseUrl: "http://ollama:11434", timeoutMs: 20 })
    ).rejects.toThrow(/timed out/i);
  });

  it("rejects vector-width drift across batches even without expectedDim", async () => {
    // Per-batch validation guarantees each request is internally consistent but
    // not that batch 2's width matches batch 1's — e.g. Ollama reloading a
    // different model mid-reindex. Without a cross-batch guard, mixed-width
    // vectors would reach the kb_chunks embedding column and fail opaquely at
    // insert instead of here.
    let call = 0;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const width = call++ === 0 ? 3 : 2; // batch 1: 3-dim, batch 2: 2-dim
      const embeddings = (body.input as string[]).map(() => Array<number>(width).fill(1));
      return new Response(JSON.stringify({ embeddings }), { status: 200 });
    });

    await expect(
      embedTexts(["a", "b", "c"], { baseUrl: "http://ollama:11434", batchSize: 2 })
    ).rejects.toThrow(/dimension/i);
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

  it("concurrent first callers share one model load instead of each loading their own", async () => {
    getEmbeddingFor.mockResolvedValue({ vector: [1, 2, 3] });
    const cfg = { baseUrl: "unused", provider: "local", modelPath: "/models/concurrent.gguf" };

    // Three parallel knowledge_search calls arriving before the model is loaded.
    await Promise.all([embedTexts(["a"], cfg), embedTexts(["b"], cfg), embedTexts(["c"], cfg)]);

    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(createEmbeddingContext).toHaveBeenCalledTimes(1);
  });

  // One Pinchy process loads src/lib twice — once for the custom server (where
  // the KB index worker runs) and once for Next's route bundles (where the
  // search route runs); see process-wide-cache.ts. A module-level cache gave
  // each its own model and its own context: twice the RAM, and two evaluate
  // locks, so a search and a reindex embedded at the same time and fought over
  // the same cores instead of queueing behind each other.
  it("shares one loaded model across module instances in the same process", async () => {
    getEmbeddingFor.mockResolvedValue({ vector: [1, 2, 3] });
    const cfg = { baseUrl: "unused", provider: "local", modelPath: "/models/two-instances.gguf" };

    await embedTexts(["from the index worker"], cfg);
    vi.resetModules();
    const { embedTexts: embedTextsFromRouteBundle } = await import("@/lib/knowledge/embeddings");
    await embedTextsFromRouteBundle(["from the search route"], cfg);

    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(createEmbeddingContext).toHaveBeenCalledTimes(1);
    expect(getEmbeddingFor).toHaveBeenCalledTimes(2);
  });

  it("creates the embedding context with the configured thread count", async () => {
    getEmbeddingFor.mockResolvedValue({ vector: [1, 2, 3] });

    await embedTexts(["a"], {
      baseUrl: "unused",
      provider: "local",
      modelPath: "/models/threads.gguf",
      threads: 1,
    });

    expect(createEmbeddingContext).toHaveBeenCalledWith({ threads: 1 });
  });

  describe("a failed load", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is retried once the cooldown has passed instead of failing every search until restart", async () => {
      vi.useFakeTimers();
      getEmbeddingFor.mockResolvedValue({ vector: [1, 2, 3] });
      loadModel.mockRejectedValueOnce(new Error("ENOMEM"));
      const cfg = { baseUrl: "unused", provider: "local", modelPath: "/models/flaky-load.gguf" };

      await expect(embedTexts(["a"], cfg)).rejects.toThrow("ENOMEM");
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_RETRY_COOLDOWN_MS);
      await expect(embedTexts(["b"], cfg)).resolves.toEqual([[1, 2, 3]]);
      expect(loadModel).toHaveBeenCalledTimes(2);
    });

    // A persistently broken load (a corrupt GGUF, a container out of memory)
    // must not load another ~300 MB model on every search.
    it("is not retried within the cooldown: searches fail fast on the same error", async () => {
      vi.useFakeTimers();
      loadModel.mockRejectedValue(new Error("ENOMEM"));
      const cfg = { baseUrl: "unused", provider: "local", modelPath: "/models/broken-load.gguf" };

      await expect(embedTexts(["a"], cfg)).rejects.toThrow("ENOMEM");
      await vi.advanceTimersByTimeAsync(LOCAL_MODEL_RETRY_COOLDOWN_MS - 1);
      await expect(embedTexts(["b"], cfg)).rejects.toThrow("ENOMEM");
      await expect(embedTexts(["c"], cfg)).rejects.toThrow("ENOMEM");
      expect(loadModel).toHaveBeenCalledTimes(1);
    });

    it("disposes a model that loaded when its embedding context could not be created", async () => {
      const dispose = vi.fn().mockResolvedValue(undefined);
      loadModel.mockResolvedValueOnce({ createEmbeddingContext, dispose });
      createEmbeddingContext.mockRejectedValueOnce(new Error("context: out of memory"));
      const cfg = { baseUrl: "unused", provider: "local", modelPath: "/models/no-context.gguf" };

      await expect(embedTexts(["a"], cfg)).rejects.toThrow("context: out of memory");
      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("reports the context error even when disposing the model throws", async () => {
      const dispose = vi.fn(() => {
        throw new Error("dispose failed");
      });
      loadModel.mockResolvedValueOnce({ createEmbeddingContext, dispose });
      createEmbeddingContext.mockRejectedValueOnce(new Error("context: out of memory"));
      const cfg = { baseUrl: "unused", provider: "local", modelPath: "/models/bad-dispose.gguf" };

      await expect(embedTexts(["a"], cfg)).rejects.toThrow("context: out of memory");
    });
  });
});

/**
 * A tokenizer that counts very differently from the chunker's 4-chars-per-token
 * estimate: every character is a token. A 600-character chunk — 150 tokens to
 * the estimate, comfortably under the 512 target — is 600 tokens here, which is
 * the shape of #1380 (a part-number table or a run of digits tokenizes far
 * denser than prose).
 */
const charTokenizer: EmbeddingTokenizer = {
  tokenize: (text) => Array.from(text),
  detokenize: (tokens) => (tokens as string[]).join(""),
};

/**
 * A SentencePiece-style tokenizer with byte fallback: ASCII and U+FFFD are in
 * the vocabulary (one token each), everything else is one token per UTF-8 byte.
 * Decoding a window that starts or ends inside a multi-byte character yields
 * U+FFFD — the way a real GGUF vocabulary decodes a rare code point it only
 * knows as bytes.
 */
const byteFallbackTokenizer: EmbeddingTokenizer = {
  tokenize: (text) =>
    Array.from(text).flatMap<string | number>((ch) =>
      ch.charCodeAt(0) < 0x80 || ch === "\uFFFD" ? [ch] : Array.from(new TextEncoder().encode(ch))
    ),
  detokenize: (tokens) => {
    let out = "";
    let bytes: number[] = [];
    const flush = () => {
      out += new TextDecoder().decode(new Uint8Array(bytes));
      bytes = [];
    };
    for (const token of tokens) {
      if (typeof token === "number") bytes.push(token);
      else {
        flush();
        out += token as string;
      }
    }
    flush();
    return out;
  },
};

/**
 * The invariants the citation viewer depends on (`locatePassage` matches a
 * chunk against the page with whitespace removed): every piece is a verbatim
 * slice of the original, in order, without overlap; only whitespace lies
 * between them; each fits the budget; no U+FFFD the original did not have.
 */
function expectPiecesOfOriginal(
  text: string,
  pieces: string[],
  tokenizer: EmbeddingTokenizer,
  budget: number
) {
  let at = 0;
  for (const piece of pieces) {
    expect(piece.trim()).not.toBe("");
    const start = text.slice(at).search(/\S/) + at;
    expect(text.slice(at, start).trim()).toBe("");
    expect(text.startsWith(piece, start)).toBe(true);
    expect(tokenizer.tokenize(piece).length).toBeLessThanOrEqual(budget);
    if (!text.includes("\uFFFD")) expect(piece).not.toContain("\uFFFD");
    at = start + piece.length;
  }
  expect(text.slice(at).trim()).toBe("");
}

describe("splitToTokenBudget", () => {
  it("leaves a text that fits alone", () => {
    expect(splitToTokenBudget("short text", charTokenizer, 100)).toEqual(["short text"]);
  });

  it("splits a chunk the estimate accepts but the tokenizer counts far above the budget", () => {
    const text = "4711-0815 ".repeat(60); // 600 chars: 150 "estimated" tokens, 600 real ones
    const pieces = splitToTokenBudget(text, charTokenizer, 256);

    expect(pieces.length).toBe(3);
    // Nothing is lost: the pieces are the chunk, cut between its words.
    expectPiecesOfOriginal(text, pieces, charTokenizer, 256);
    expect(pieces.join(" ")).toBe(text.trim());
  });

  // Decoding a window of tokens back to text is what put U+FFFD into stored
  // chunks: a byte-fallback character cut between its bytes. The pieces are
  // cut from the original text instead; the tokenizer only measures.
  it("never cuts a character between its bytes, so every piece is a substring of the original", () => {
    // CJK Extension B: four UTF-8 bytes each, tokenized as bytes.
    const text = Array.from({ length: 60 }, (_, i) => String.fromCodePoint(0x20000 + i * 7)).join(
      ""
    );
    const pieces = splitToTokenBudget(text, byteFallbackTokenizer, 10);

    expect(pieces.length).toBeGreaterThan(1);
    expectPiecesOfOriginal(text, pieces, byteFallbackTokenizer, 10);
    expect(pieces.join("")).toBe(text);
  });

  it("keeps every piece findable on the page it came from", () => {
    const runs = [
      "Prüfprotokoll 𠀀𠀇𠀎 Pumpe 7",
      "Messwert 4711-0815 laut Datenblatt",
      "Ventil 𠀕𠀜𠀣 geprüft und freigegeben.",
      "Nächste Wartung in zwölf Monaten 𠀪𠀱𠀸.",
    ];
    const text = runs.join("\n");
    const pieces = splitToTokenBudget(text, byteFallbackTokenizer, 40);

    expect(pieces.length).toBeGreaterThan(1);
    expectPiecesOfOriginal(text, pieces, byteFallbackTokenizer, 40);
    for (const piece of pieces) {
      if (piece.replace(/\s+/g, "").length >= 12) expect(locatePassage(runs, piece)).not.toBeNull();
    }
  });

  it("prefers a paragraph break over a line break", () => {
    const text = "a".repeat(30) + "\n\n" + "b".repeat(20) + "\n" + "c".repeat(20);
    const pieces = splitToTokenBudget(text, charTokenizer, 60);
    expect(pieces[0]).toBe("a".repeat(30));
    expectPiecesOfOriginal(text, pieces, charTokenizer, 60);
  });

  // chunk.ts keeps a table line whole on purpose; a cut inside the row would
  // separate a part number from its value.
  it("prefers a line break over a sentence end or a space", () => {
    const row = (n: number) => `Teil ${n}. Wert ${n * 3} Stück`;
    const text = [row(1), row(2), row(3), row(4), row(5)].join("\n");
    const pieces = splitToTokenBudget(text, charTokenizer, 50);
    for (const piece of pieces) {
      for (const line of piece.split("\n")) expect(text.split("\n")).toContain(line);
    }
    expectPiecesOfOriginal(text, pieces, charTokenizer, 50);
  });

  it("prefers a sentence end over a space", () => {
    const text = "One two three four. Five six seven eight nine ten eleven";
    const pieces = splitToTokenBudget(text, charTokenizer, 30);
    expect(pieces[0]).toBe("One two three four.");
    expectPiecesOfOriginal(text, pieces, charTokenizer, 30);
  });

  it("cuts a line without any space between graphemes, never inside one", () => {
    const text = "e\u0301".repeat(40); // "é" as a base letter plus a combining accent
    const pieces = splitToTokenBudget(text, charTokenizer, 15);
    for (const piece of pieces) expect(piece.startsWith("\u0301")).toBe(false);
    expectPiecesOfOriginal(text, pieces, charTokenizer, 15);
    expect(pieces.join("")).toBe(text);
  });

  // One enormous line can be a whole page. Measuring the rest of the text for
  // every piece would make a long chunk quadratic.
  it("measures a bounded window per piece, not the rest of the text", () => {
    const measured: number[] = [];
    const counting: EmbeddingTokenizer = {
      tokenize: (text) => {
        measured.push(text.length);
        return Array.from(text);
      },
      detokenize: (tokens) => (tokens as string[]).join(""),
    };
    const text = "z".repeat(200_000);
    const pieces = splitToTokenBudget(text, counting, 100);

    expect(pieces.join("")).toBe(text);
    // The first call measures the whole text to decide whether to split at all.
    expect(Math.max(...measured.slice(1))).toBeLessThan(10_000);
  });

  // Decoding a window and tokenizing it again is not always the same count: a
  // merge that only forms across the seam, a token that decodes longer than it
  // read. The piece is what gets embedded, so the piece is what must fit.
  it("shrinks a cut whose text measures past the budget", () => {
    // Every "x" decodes to "xx" — so the decoded window overestimates the cut twice over.
    const inflating: EmbeddingTokenizer = {
      tokenize: (text) => Array.from(text),
      detokenize: (tokens) => (tokens as string[]).map((t) => (t === "x" ? "xx" : t)).join(""),
    };
    const text = "x".repeat(40);
    const pieces = splitToTokenBudget(text, inflating, 10);
    expectPiecesOfOriginal(text, pieces, inflating, 10);
    expect(pieces.join("")).toBe(text);
  });

  it("drops a whitespace-only piece rather than embedding nothing", () => {
    const pieces = splitToTokenBudget("a".repeat(10) + " ".repeat(10), charTokenizer, 10);
    expect(pieces).toEqual(["a".repeat(10)]);
  });
});

describe("fitTextsForEmbedding (provider: local, node-llama-cpp mocked)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLlama.mockResolvedValue({ loadModel });
  });

  function modelWithContext(contextSize: number, trainContextSize = 2048) {
    const model = {
      trainContextSize,
      tokenize: (text: string) => Array.from(text),
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext,
    };
    loadModel.mockResolvedValue(model);
    createEmbeddingContext.mockResolvedValue({ getEmbeddingFor, _llamaContext: { contextSize } });
  }

  it("splits a text the model's own tokenizer counts past the context, and leaves the rest", async () => {
    modelWithContext(64);
    const long = "9".repeat(150);
    const fitted = await fitTextsForEmbedding(["fits", long], {
      baseUrl: "unused",
      provider: "local",
      modelPath: "/models/fit-split.gguf",
    });

    expect(fitted[0]).toEqual(["fits"]);
    expect(fitted[1].length).toBeGreaterThan(2);
    // A little headroom under the context: node-llama-cpp checks the length
    // before it adds the BOS/EOS tokens the model still needs room for.
    for (const piece of fitted[1]) expect(piece.length).toBeLessThan(64);
    expect(fitted[1].join("")).toBe(long);
  });

  // node-llama-cpp decodes an input longer than the batch in several calls,
  // and the pooled vector then reflects only the last batch: the head of the
  // piece would silently drop out of its own embedding.
  it("splits to the context's batch size when that is smaller than the context", async () => {
    const model = {
      trainContextSize: 2048,
      tokenize: (text: string) => Array.from(text),
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext,
    };
    loadModel.mockResolvedValue(model);
    createEmbeddingContext.mockResolvedValue({
      getEmbeddingFor,
      _llamaContext: { contextSize: 2048, batchSize: 40 },
    });

    const [pieces] = await fitTextsForEmbedding(["q".repeat(200)], {
      baseUrl: "unused",
      provider: "local",
      modelPath: "/models/fit-batch.gguf",
    });
    expect(pieces.length).toBeGreaterThan(4);
    for (const piece of pieces) expect(piece.length).toBeLessThan(40);
  });

  it("falls back to the model's training context when the context size is not readable", async () => {
    const model = {
      trainContextSize: 32,
      tokenize: (text: string) => Array.from(text),
      detokenize: (tokens: string[]) => tokens.join(""),
      createEmbeddingContext,
    };
    loadModel.mockResolvedValue(model);
    createEmbeddingContext.mockResolvedValue({ getEmbeddingFor });

    const [pieces] = await fitTextsForEmbedding(["z".repeat(100)], {
      baseUrl: "unused",
      provider: "local",
      modelPath: "/models/fit-train-ctx.gguf",
    });
    for (const piece of pieces) expect(piece.length).toBeLessThan(32);
  });

  it("splits for the Ollama path by characters, without a network call", async () => {
    const fitted = await fitTextsForEmbedding(["a".repeat(5000)], {
      baseUrl: "http://ollama:11434",
    });
    expect(fitted[0].length).toBeGreaterThan(1);
    expect(fitted[0].join("")).toBe("a".repeat(5000));
    expect(fetch).not.toHaveBeenCalled();
  });
});

// The run-stopping errors are told apart by type, not by message: an embedder
// that cannot embed anything is one outage, an input it refuses is one file.
describe("EmbedderUnavailableError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLlama.mockResolvedValue({ loadModel });
    loadModel.mockResolvedValue({ createEmbeddingContext });
    createEmbeddingContext.mockResolvedValue({ getEmbeddingFor });
  });

  it("is what a model that will not load throws", async () => {
    loadModel.mockRejectedValueOnce(new Error("ENOMEM"));
    const err = await embedTexts(["a"], {
      baseUrl: "unused",
      provider: "local",
      modelPath: "/models/typed-load-failure.gguf",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EmbedderUnavailableError);
    expect(err.message).toContain("ENOMEM");
  });

  it("is not what an input the context refuses throws", async () => {
    getEmbeddingFor.mockRejectedValueOnce(
      new Error("Input is longer than the context size. Try to increase the context size")
    );
    const err = await embedTexts(["a"], {
      baseUrl: "unused",
      provider: "local",
      modelPath: "/models/typed-input-failure.gguf",
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(EmbedderUnavailableError);
  });

  it("is what an unreachable Ollama throws", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(embedTexts(["a"], { baseUrl: "http://ollama:11434" })).rejects.toBeInstanceOf(
      EmbedderUnavailableError
    );
  });

  it("is what a wrong vector width throws", async () => {
    getEmbeddingFor.mockResolvedValue({ vector: [1, 2, 3] });
    await expect(
      embedTexts(["a"], {
        baseUrl: "unused",
        provider: "local",
        modelPath: "/models/typed-width.gguf",
        expectedDim: 768,
      })
    ).rejects.toBeInstanceOf(EmbedderUnavailableError);
  });
});
