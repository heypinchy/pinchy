import { renderHook } from "@testing-library/react";
import { useDraftId } from "@/hooks/use-draft-id";

describe("useDraftId", () => {
  beforeEach(() => localStorage.clear());

  it("generates a UUID on first mount and stores it", () => {
    const { result } = renderHook(() => useDraftId("agent-1"));
    expect(result.current).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem("pinchy:composer:agent-1:draftId")).toBe(result.current);
  });

  it("returns the same UUID on re-mount (localStorage persistence)", () => {
    const { result: first } = renderHook(() => useDraftId("agent-1"));
    const firstId = first.current;
    const { result: second } = renderHook(() => useDraftId("agent-1"));
    expect(second.current).toBe(firstId);
  });

  it("uses distinct IDs for different agentIds", () => {
    const { result: a } = renderHook(() => useDraftId("agent-1"));
    const { result: b } = renderHook(() => useDraftId("agent-2"));
    expect(a.current).not.toBe(b.current);
  });
});
