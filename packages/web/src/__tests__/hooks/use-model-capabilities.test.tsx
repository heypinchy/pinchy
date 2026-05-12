import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useModelCapabilities, _resetModuleCacheForTest } from "@/hooks/use-model-capabilities";

const MOCK_CAPABILITIES = {
  "anthropic/claude-opus-4-7": {
    vision: true,
    documents: true,
    audio: false,
    video: false,
    longContext: true,
    tools: true,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  _resetModuleCacheForTest();
});

describe("useModelCapabilities", () => {
  it("fetches and returns the capability map", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_CAPABILITIES,
    } as unknown as Response);

    const { result } = renderHook(() => useModelCapabilities());
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data?.["anthropic/claude-opus-4-7"].vision).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("exposes isLoading=true initially", () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useModelCapabilities());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it("sets error when fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useModelCapabilities());
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.isLoading).toBe(false);
  });

  it("coalesces concurrent mounts into a single fetch", async () => {
    // Two components mounting on the same tick must not each trigger their
    // own GET — that's wasted bandwidth and produces redundant load on the
    // server's models table.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_CAPABILITIES,
    } as unknown as Response);
    globalThis.fetch = fetchSpy;

    const { result: r1 } = renderHook(() => useModelCapabilities());
    const { result: r2 } = renderHook(() => useModelCapabilities());

    await waitFor(() => expect(r1.current.data).toBeTruthy());
    await waitFor(() => expect(r2.current.data).toBeTruthy());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
