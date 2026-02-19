import { describe, it, expect, vi, beforeEach } from "vitest";
import { shouldTriggerGreeting, markGreetingSent } from "@/lib/greeting";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

import { getSetting, setSetting } from "@/lib/settings";

describe("greeting trigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true when greeting is pending", async () => {
    vi.mocked(getSetting).mockResolvedValue("true");

    const result = await shouldTriggerGreeting();
    expect(result).toBe(true);
    expect(getSetting).toHaveBeenCalledWith("onboarding_greeting_pending");
  });

  it("should return false when greeting already sent", async () => {
    vi.mocked(getSetting).mockResolvedValue("false");

    const result = await shouldTriggerGreeting();
    expect(result).toBe(false);
  });

  it("should return false when setting not found", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    const result = await shouldTriggerGreeting();
    expect(result).toBe(false);
  });

  it("should mark greeting as sent", async () => {
    await markGreetingSent();
    expect(setSetting).toHaveBeenCalledWith("onboarding_greeting_pending", "false", false);
  });
});
