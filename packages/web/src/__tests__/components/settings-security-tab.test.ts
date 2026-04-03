import { describe, it, expect } from "vitest";
import { SETTINGS_TABS } from "@/hooks/use-tab-param";

describe("Settings security tab", () => {
  it("should include 'security' in SETTINGS_TABS", () => {
    expect(SETTINGS_TABS).toContain("security");
  });

  it("should have 'security' as the last tab", () => {
    expect(SETTINGS_TABS[SETTINGS_TABS.length - 1]).toBe("security");
  });
});
