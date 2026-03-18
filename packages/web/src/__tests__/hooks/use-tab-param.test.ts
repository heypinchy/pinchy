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

import { useTabParam, SETTINGS_TABS, AGENT_SETTINGS_TABS } from "@/hooks/use-tab-param";

describe("useTabParam", () => {
  beforeEach(() => {
    mockSearchParams.delete("tab");
    mockReplace.mockClear();
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

    expect(result.current[0]).toBe("license");
    expect(mockReplace).toHaveBeenCalledWith("/settings?tab=license", {
      scroll: false,
    });
  });

  it("removes the tab param when switching to the default tab", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("context");
    });

    expect(result.current[0]).toBe("context");
    expect(mockReplace).toHaveBeenCalledWith("/settings", { scroll: false });
  });

  it("falls back to default tab when URL param is not in valid set", () => {
    mockSearchParams.set("tab", "nonexistent");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    expect(result.current[0]).toBe("context");
  });

  it("falls back to default when member tab set excludes admin tabs", () => {
    mockSearchParams.set("tab", "license");
    const memberTabs = ["context", "profile"] as const;

    const { result } = renderHook(() => useTabParam("context", memberTabs));

    expect(result.current[0]).toBe("context");
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
