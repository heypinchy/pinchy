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
});
