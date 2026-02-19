import { describe, it, expect, vi, beforeEach } from "vitest";
import { isProviderConfigured } from "@/lib/setup";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
}));

import { getSetting } from "@/lib/settings";

describe("isProviderConfigured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true when default_provider is set", async () => {
    vi.mocked(getSetting).mockResolvedValue("anthropic");

    const result = await isProviderConfigured();
    expect(result).toBe(true);
    expect(getSetting).toHaveBeenCalledWith("default_provider");
  });

  it("should return false when default_provider is not set", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    const result = await isProviderConfigured();
    expect(result).toBe(false);
  });
});
