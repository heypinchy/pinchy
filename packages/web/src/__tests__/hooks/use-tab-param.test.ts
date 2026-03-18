import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => "/settings",
  useRouter: () => ({ replace: mockReplace }),
}));

import { useTabParam } from "@/hooks/use-tab-param";

describe("useTabParam", () => {
  beforeEach(() => {
    // Reset search params to empty
    mockSearchParams.delete("tab");
    mockReplace.mockClear();
  });

  it("returns the default tab when no URL param is present", () => {
    const { result } = renderHook(() => useTabParam("context"));

    expect(result.current[0]).toBe("context");
  });

  it("returns the tab from the URL param when present", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context"));

    expect(result.current[0]).toBe("license");
  });

  it("updates the URL when the tab changes", () => {
    const { result } = renderHook(() => useTabParam("context"));

    act(() => {
      result.current[1]("license");
    });

    expect(result.current[0]).toBe("license");
    expect(mockReplace).toHaveBeenCalledWith("/settings?tab=license", {
      scroll: false,
    });
  });

  it("removes the tab param when switching to the default tab", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context"));

    act(() => {
      result.current[1]("context");
    });

    expect(result.current[0]).toBe("context");
    expect(mockReplace).toHaveBeenCalledWith("/settings", { scroll: false });
  });
});
