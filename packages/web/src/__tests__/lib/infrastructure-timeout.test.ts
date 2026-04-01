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

  it("should use a 5 second timeout and return unreachable on timeout", async () => {
    vi.useFakeTimers();
    process.env.OPENCLAW_WS_URL = "ws://openclaw:18789";

    let rejectFetch: (reason: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, opts?: { signal?: AbortSignal }) => {
        return new Promise((_, reject) => {
          rejectFetch = reject;
          // Abort signal triggers rejection when timeout fires
          opts?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        });
      })
    );

    const promise = checkOpenClaw();

    // Advance past the 5s timeout
    await vi.advanceTimersByTimeAsync(5100);

    const result = await promise;
    expect(result).toBe("unreachable");

    vi.useRealTimers();
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
