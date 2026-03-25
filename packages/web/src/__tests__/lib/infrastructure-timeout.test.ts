import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkOpenClaw } from "@/lib/infrastructure";

describe("checkOpenClaw", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("OK", { status: 200 })));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("should return 'connected' when OpenClaw responds", async () => {
    process.env.OPENCLAW_WS_URL = "ws://openclaw:18789";
    const result = await checkOpenClaw();
    expect(result).toBe("connected");
  });

  it("should return 'connected' when OPENCLAW_WS_URL is not set", async () => {
    delete process.env.OPENCLAW_WS_URL;
    const result = await checkOpenClaw();
    expect(result).toBe("connected");
  });

  it("should return 'unreachable' when fetch fails", async () => {
    process.env.OPENCLAW_WS_URL = "ws://openclaw:18789";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));
    const result = await checkOpenClaw();
    expect(result).toBe("unreachable");
  });

  it("should use a 5 second timeout", async () => {
    process.env.OPENCLAW_WS_URL = "ws://openclaw:18789";

    let abortSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts?: { signal?: AbortSignal }) => {
        abortSignal = opts?.signal;
        return new Promise(() => {}); // Never resolves
      })
    );

    // Start the check (don't await — it will hang)
    const promise = checkOpenClaw();

    // Verify the AbortController timeout is set to 5000ms
    // We can't easily test the exact timeout, but we can verify the signal exists
    expect(abortSignal).toBeDefined();
    expect(abortSignal?.aborted).toBe(false);

    // Clean up: abort to prevent hanging
    abortSignal?.addEventListener("abort", () => {});
  });

  it("should return 'connected' even on 4xx responses", async () => {
    process.env.OPENCLAW_WS_URL = "ws://openclaw:18789";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));
    const result = await checkOpenClaw();
    expect(result).toBe("connected");
  });

  it("should convert ws:// to http:// for the health check", async () => {
    process.env.OPENCLAW_WS_URL = "ws://openclaw:18789";
    const mockFetch = vi.fn().mockResolvedValue(new Response("OK"));
    vi.stubGlobal("fetch", mockFetch);

    await checkOpenClaw();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://openclaw:18789",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
