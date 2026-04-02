import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
}));

import { getDomain } from "@/lib/domain";
import { getSetting } from "@/lib/settings";

describe("getDomain", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset();
  });

  it("should return null when no domain is set", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);
    const result = await getDomain();
    expect(result).toBeNull();
    expect(getSetting).toHaveBeenCalledWith("domain");
  });

  it("should return the domain when set", async () => {
    vi.mocked(getSetting).mockResolvedValue("pinchy.example.com");
    const result = await getDomain();
    expect(result).toBe("pinchy.example.com");
  });

  it("should return domain with port when set", async () => {
    vi.mocked(getSetting).mockResolvedValue("pinchy.example.com:8443");
    const result = await getDomain();
    expect(result).toBe("pinchy.example.com:8443");
  });
});
