// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { useGrantedFolders } from "@/hooks/use-granted-folders";
import { jsonResponse } from "@/test-helpers/fetch";

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const folders = [
  { path: "/data/suppliers", status: "available" },
  { path: "/data/pinchy-suppliers", status: "missing" },
];

describe("useGrantedFolders (#1363)", () => {
  it("asks the server about the agent's saved grants", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ folders }));

    const { result } = renderHook(() => useGrantedFolders("agent-1", "a|b", true));

    await waitFor(() => expect(result.current).toEqual(folders));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/agents/agent-1/granted-folders");
  });

  it("asks nothing when not enabled — the route is admin-only", () => {
    const { result } = renderHook(() => useGrantedFolders("agent-1", "a|b", false));

    expect(result.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks again once the saved grants change, so a removed grant stops being reported", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ folders }));
    const { rerender } = renderHook(({ saved }) => useGrantedFolders("agent-1", saved, true), {
      initialProps: { saved: "a|b" },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ saved: "a" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("answers nothing when the check fails, so grants show as stored", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, { status: 500 }));

    const { result } = renderHook(() => useGrantedFolders("agent-1", "a|b", true));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
  });
});
