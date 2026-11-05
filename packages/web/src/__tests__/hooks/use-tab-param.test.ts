// @vitest-environment jsdom
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

// The hook writes history directly (#1271); Next.js syncs native pushState
// into useSearchParams without a server round trip.
const pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
const pushedUrls = () => pushState.mock.calls.map(([, , url]) => url);

describe("useTabParam", () => {
  beforeEach(() => {
    mockSearchParams.delete("tab");
    mockReplace.mockClear();
    mockPush.mockClear();
    pushState.mockClear();
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

    expect(pushedUrls()).toEqual(["/settings?tab=license"]);

    // Simulate the URL update that pushState triggers
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

    expect(pushedUrls()).toEqual(["/settings"]);

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

    expect(pushedUrls()).toEqual(["/settings?tab=context"]);
  });

  it("still removes the tab param on the default tab when keepParamForDefault is not set", () => {
    mockSearchParams.set("tab", "license");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("context");
    });

    expect(pushedUrls()).toEqual(["/settings"]);
  });

  it("pushes a history entry when entering a tab from the menu (not yet explicit)", () => {
    // No `?tab=` param → not explicit → this is a drill-in from the menu level.
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("license");
    });

    expect(pushedUrls()).toEqual(["/settings?tab=license"]);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("pushes when switching tabs while already explicit, so Back walks the tabs (#951)", () => {
    mockSearchParams.set("tab", "profile");

    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("license");
    });

    expect(pushedUrls()).toEqual(["/settings?tab=license"]);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("gives every tab in a multi-tab walk its own history entry (#951)", () => {
    // The reported repro: Context → Profile → Telegram → Support produced a
    // single history entry, so two Back presses left Settings entirely.
    for (const [from, to] of [
      [null, "profile"],
      ["profile", "telegram"],
      ["telegram", "support"],
    ] as const) {
      if (from) mockSearchParams.set("tab", from);
      else mockSearchParams.delete("tab");

      const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));
      act(() => {
        result.current[1](to);
      });
    }

    expect(pushedUrls()).toEqual([
      "/settings?tab=profile",
      "/settings?tab=telegram",
      "/settings?tab=support",
    ]);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not push a second entry for the URL the browser is already on", () => {
    // Radix Tabs fires onValueChange on mousedown and again on the focus that
    // follows, so one click can ask for the same tab twice. router.push
    // swallowed the duplicate; a native pushState would add an entry, and
    // Back would then appear to do nothing (#951's symptom, from the other side).
    window.history.replaceState(null, "", "/settings?tab=license");
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("license");
    });

    expect(pushedUrls()).toEqual([]);
    window.history.replaceState(null, "", "/");
  });

  it("honours initialTab while the URL is still the one the page was rendered for", () => {
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS, "license"));

    expect(result.current[0]).toBe("license");
    expect(result.current[2]).toBe(true);
  });

  it("stops honouring initialTab once the URL has moved on (#1271)", () => {
    // initialTab comes from the server render. Tab switches no longer re-run
    // that render, so the prop keeps its first value: once the URL loses the
    // tab param (default tab, or the mobile back-to-menu control), falling
    // back to it would pin the page to the tab it was first opened on.
    mockSearchParams.set("tab", "license");
    const { result, rerender } = renderHook(() => useTabParam("context", SETTINGS_TABS, "license"));
    expect(result.current[0]).toBe("license");

    mockSearchParams.delete("tab");
    rerender();

    expect(result.current[0]).toBe("context");
    expect(result.current[2]).toBe(false);
  });

  it("switches tabs without a router navigation, so the page is not remounted (#1271)", () => {
    // The App Router keys the page segment by its search params: router.push
    // to a new ?tab= re-renders the server page and remounts every tab, which
    // refetches everything and shows "Loading..." on each switch.
    mockSearchParams.set("tab", "users");
    const { result } = renderHook(() => useTabParam("context", SETTINGS_TABS));

    act(() => {
      result.current[1]("groups");
    });

    expect(pushedUrls()).toEqual(["/settings?tab=groups"]);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
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
