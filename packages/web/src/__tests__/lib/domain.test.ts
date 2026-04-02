import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));

vi.mock("@/lib/setup", () => ({
  isSetupComplete: vi.fn(),
}));

import {
  getDomain,
  isInsecureMode,
  getCachedDomain,
  loadDomainCache,
  setDomainAndRefreshCache,
  deleteDomainAndRefreshCache,
  _resetCacheForTests,
} from "@/lib/domain";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
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

describe("domain cache", () => {
  beforeEach(() => {
    _resetCacheForTests();
    vi.mocked(getSetting).mockReset();
    vi.mocked(setSetting).mockReset();
    vi.mocked(deleteSetting).mockReset();
  });

  describe("getCachedDomain", () => {
    it("should return null when cache has not been loaded", () => {
      expect(getCachedDomain()).toBeNull();
    });

    it("should return cached domain after loadDomainCache", async () => {
      vi.mocked(getSetting).mockResolvedValue("pinchy.example.com");
      await loadDomainCache();
      expect(getCachedDomain()).toBe("pinchy.example.com");
    });

    it("should return null after loadDomainCache when no domain is set", async () => {
      vi.mocked(getSetting).mockResolvedValue(null);
      await loadDomainCache();
      expect(getCachedDomain()).toBeNull();
    });
  });

  describe("loadDomainCache", () => {
    it("should read domain from settings", async () => {
      vi.mocked(getSetting).mockResolvedValue("pinchy.example.com");
      await loadDomainCache();
      expect(getSetting).toHaveBeenCalledWith("domain");
      expect(getCachedDomain()).toBe("pinchy.example.com");
    });
  });

  describe("setDomainAndRefreshCache", () => {
    it("should persist domain to settings and update cache", async () => {
      vi.mocked(setSetting).mockResolvedValue(undefined);
      await setDomainAndRefreshCache("pinchy.example.com");
      expect(setSetting).toHaveBeenCalledWith("domain", "pinchy.example.com");
      expect(getCachedDomain()).toBe("pinchy.example.com");
    });
  });

  describe("deleteDomainAndRefreshCache", () => {
    it("should delete domain from settings and clear cache", async () => {
      // Pre-populate cache
      vi.mocked(getSetting).mockResolvedValue("pinchy.example.com");
      await loadDomainCache();
      expect(getCachedDomain()).toBe("pinchy.example.com");

      // Delete
      vi.mocked(deleteSetting).mockResolvedValue(undefined);
      await deleteDomainAndRefreshCache();
      expect(deleteSetting).toHaveBeenCalledWith("domain");
      expect(getCachedDomain()).toBeNull();
    });
  });
});
