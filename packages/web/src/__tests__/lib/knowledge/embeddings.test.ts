import { describe, it, expect, vi, beforeEach } from "vitest";
import { embedTexts } from "@/lib/knowledge/embeddings";

global.fetch = vi.fn();

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
});
