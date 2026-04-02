import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
}));

vi.mock("@/lib/setup", () => ({
  isSetupComplete: vi.fn(),
}));

import { getDomain, isInsecureMode } from "@/lib/domain";
import { getSetting } from "@/lib/settings";
import { isSetupComplete } from "@/lib/setup";

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

describe("isInsecureMode", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset();
    vi.mocked(isSetupComplete).mockReset();
  });

  it("should return false when setup is not complete", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(false);
    vi.mocked(getSetting).mockResolvedValue(null);
    expect(await isInsecureMode()).toBe(false);
  });

  it("should return true when setup is complete and no domain is set", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(true);
    vi.mocked(getSetting).mockResolvedValue(null);
    expect(await isInsecureMode()).toBe(true);
  });

  it("should return false when setup is complete and domain is set", async () => {
    vi.mocked(isSetupComplete).mockResolvedValue(true);
    vi.mocked(getSetting).mockResolvedValue("pinchy.example.com");
    expect(await isInsecureMode()).toBe(false);
  });
});
