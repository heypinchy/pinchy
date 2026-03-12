import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
}));

import { getSetting } from "@/lib/settings";
import { isEnterprise } from "@/lib/enterprise";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PINCHY_ENTERPRISE_KEY;
});

describe("isEnterprise", () => {
  it("returns true when PINCHY_ENTERPRISE_KEY env var is set", async () => {
    process.env.PINCHY_ENTERPRISE_KEY = "test-key";
    const result = await isEnterprise();
    expect(result).toBe(true);
    // Should not even check DB when env var is present
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("returns false when no env var and no DB setting", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce(null);
    const result = await isEnterprise();
    expect(result).toBe(false);
    expect(getSetting).toHaveBeenCalledWith("enterprise_key");
  });

  it("returns true when DB setting 'enterprise_key' exists", async () => {
    vi.mocked(getSetting).mockResolvedValueOnce("some-enterprise-key");
    const result = await isEnterprise();
    expect(result).toBe(true);
    expect(getSetting).toHaveBeenCalledWith("enterprise_key");
  });
});
