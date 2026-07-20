import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
const mockReplace = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
  usePathname: () => "/settings",
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));

import { useTabParam, SETTINGS_TABS, AGENT_SETTINGS_TABS } from "@/hooks/use-tab-param";

describe("useTabParam", () => {
  beforeEach(() => {
    mockSearchParams.delete("tab");
    mockReplace.mockClear();
    mockPush.mockClear();
  });

  it("returns the default tab when no URL param is present", () => {
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[0]).toBe("context");
  });

  it("returns the tab from the URL param when present", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[0]).toBe("license");
  });

  it("updates the URL when the tab changes", () => {
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("license");
    });

    expect(mockReplace).toHaveBeenCalledWith("/settings?tab=license", {
      scroll: false,
    });

    // Simulate the URL update that router.replace triggers
    mockSearchParams.set("tab", "license");
    const { result: updated } = renderHook(() => useTabParam("context", SETTINGS_TABS));
    expect(updated.current[0]).toBe("license");
  });

  it("removes the tab param when switching to the default tab", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("context");
    });

    expect(mockReplace).toHaveBeenCalledWith("/settings", { scroll: false });

    // Simulate the URL update
    mockSearchParams.delete("tab");
    const { result: updated } = renderHook(() => useTabParam("context", SETTINGS_TABS));
    expect(updated.current[0]).toBe("context");
  });

  it("falls back to default tab when URL param is not in valid set", () => {
    mockSearchParams.set("tab", "nonexistent");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[0]).toBe("context");
  });

  it("syncs when search params change after initial render (hydration)", () => {
    // Simulates: initial render has no params (SSR), then params arrive (client hydration)
    const { result, rerender } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[0]).toBe("context");

    // Search params arrive after hydration
    mockSearchParams.set("tab", "license");
    rerender();

    expect(result.current[0]).toBe("license");
  });

  it("falls back to default when member tab set excludes admin tabs", () => {
    mockSearchParams.set("tab", "license");
    const memberTabs = ["context", "profile"] as const;

    const { result } = renderHook(() => useTabParam("context", memberTabs));

    expect(result.current[0]).toBe("context");
  });

  it("reports isExplicit as false when no tab param is present", () => {
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[2]).toBe(false);
  });

  it("reports isExplicit as true when a valid tab param is present", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[2]).toBe(true);
  });

  it("reports isExplicit as false when the tab param is invalid", () => {
    mockSearchParams.set("tab", "nonexistent");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[2]).toBe(false);
  });

  it("keeps the tab param on the default tab when keepParamForDefault is set", () => {
    const { result } = renderHook(() =>
      useTabParam("context", SETTINGS_TABS, undefined, { keepParamForDefault: true })
    );

    act(() => {
      result.current[1]("context");
    });

    expect(mockReplace).toHaveBeenCalledWith("/settings?tab=context", {
      scroll: false,
    });
  });

  it("still removes the tab param on the default tab when keepParamForDefault is not set", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("context");
    });

    expect(mockReplace).toHaveBeenCalledWith("/settings", { scroll: false });
  });

  it("pushes a history entry when entering a tab from the menu (pushOnEnter, not yet explicit)", () => {
    // No `?tab=` param → not explicit → this is a drill-in from the menu level.
    const { result } = renderHook(() =>
      useTabParam("context", SETTINGS_TABS, undefined, { pushOnEnter: true })
    );

    act(() => {
      result.current[1]("license");
    });

    expect(mockPush).toHaveBeenCalledWith("/settings?tab=license", { scroll: false });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("replaces (no history spam) when switching tabs while already explicit (pushOnEnter)", () => {
    mockSearchParams.set("tab", "profile");

    const { result } = renderHook(() =>
      useTabParam("context", SETTINGS_TABS, undefined, { pushOnEnter: true })
    );

    act(() => {
      result.current[1]("license");
    });

    expect(mockReplace).toHaveBeenCalledWith("/settings?tab=license", { scroll: false });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("never pushes when pushOnEnter is not set", () => {
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("license");
    });

    expect(mockReplace).toHaveBeenCalledWith("/settings?tab=license", { scroll: false });
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("tab constants", () => {
  it("SETTINGS_TABS includes all settings tabs", () => {
    expect(SETTINGS_TABS).toContain("context");
    expect(SETTINGS_TABS).toContain("profile");
    expect(SETTINGS_TABS).toContain("provider");
    expect(SETTINGS_TABS).toContain("users");
    expect(SETTINGS_TABS).toContain("groups");
    expect(SETTINGS_TABS).toContain("license");
  });

  it("AGENT_SETTINGS_TABS includes all agent settings tabs", () => {
    expect(AGENT_SETTINGS_TABS).toContain("general");
    expect(AGENT_SETTINGS_TABS).toContain("personality");
    expect(AGENT_SETTINGS_TABS).toContain("instructions");
    expect(AGENT_SETTINGS_TABS).toContain("permissions");
    expect(AGENT_SETTINGS_TABS).toContain("access");
  });
});
