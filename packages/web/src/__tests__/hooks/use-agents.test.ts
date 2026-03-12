import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgents } from "@/hooks/use-agents";
import type { Agent } from "@/components/agent-list";

const mockAgents: Agent[] = [
  {
    id: "a1",
    name: "Smithers",
    model: "gpt-4",
    isPersonal: false,
    tagline: null,
    avatarSeed: null,
  },
  { id: "a2", name: "Helper", model: "gpt-4", isPersonal: true, tagline: null, avatarSeed: null },
];

const updatedAgents: Agent[] = [
  {
    id: "a1",
    name: "Smithers",
    model: "gpt-4",
    isPersonal: false,
    tagline: null,
    avatarSeed: null,
  },
];

describe("useAgents", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => updatedAgents,
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("should return initial agents immediately", () => {
    const { result } = renderHook(() => useAgents(mockAgents));
    expect(result.current).toEqual(mockAgents);
  });

  it("should poll /api/agents every 30 seconds", async () => {
    const { result } = renderHook(() => useAgents(mockAgents));

    // No fetch before 30s
    expect(fetchSpy).not.toHaveBeenCalled();

    // Advance 30s — use advanceTimersByTimeAsync to flush microtasks (fetch promises)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(fetchSpy).toHaveBeenCalledWith("/api/agents");
    expect(result.current).toEqual(updatedAgents);
  });

  it("should refetch when window regains focus", async () => {
    const { result } = renderHook(() => useAgents(mockAgents));

    expect(fetchSpy).not.toHaveBeenCalled();

    // Simulate focus — need to flush microtasks for the fetch promise
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchSpy).toHaveBeenCalledWith("/api/agents");
    expect(result.current).toEqual(updatedAgents);
  });

  it("should not update agents when fetch fails", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false } as Response);

    const { result } = renderHook(() => useAgents(mockAgents));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // Should keep initial agents on failure
    expect(result.current).toEqual(mockAgents);
  });

  it("should clean up interval and listener on unmount", () => {
    const removeListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() => useAgents(mockAgents));
    unmount();

    expect(removeListenerSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    removeListenerSpy.mockRestore();
  });

  it("should update when initial agents prop changes (SSR revalidation)", () => {
    const { result, rerender } = renderHook(({ agents }) => useAgents(agents), {
      initialProps: { agents: mockAgents },
    });

    expect(result.current).toEqual(mockAgents);

    const newAgents: Agent[] = [
      { id: "a3", name: "New", model: "gpt-4", isPersonal: false, tagline: null, avatarSeed: null },
    ];
    rerender({ agents: newAgents });

    expect(result.current).toEqual(newAgents);
  });
});
