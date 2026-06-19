import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { shouldUseSecureCookies } from "@/lib/secure-cookies";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the secrets-volume flag at a throwaway dir so the domain-lock-flag
// writes in domain.ts are hermetic and never touch /app/secrets.
let flagDir: string;
let prevEncDir: string | undefined;
beforeEach(() => {
  flagDir = mkdtempSync(join(tmpdir(), "pinchy-domain-flag-"));
  prevEncDir = process.env.ENCRYPTION_KEY_DIR;
  process.env.ENCRYPTION_KEY_DIR = flagDir;
});
afterEach(() => {
  if (prevEncDir === undefined) delete process.env.ENCRYPTION_KEY_DIR;
  else process.env.ENCRYPTION_KEY_DIR = prevEncDir;
  rmSync(flagDir, { recursive: true, force: true });
});

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

// Closes the integration loop the unit tests can't: that domain.ts actually
// keeps the secure-cookie flag (read by auth.ts at import) in step with the
// domain-lock state. Uses the real @/lib/secure-cookies against a temp dir.
describe("domain-lock flag wiring (secure cookies)", () => {
  beforeEach(() => {
    _resetCacheForTests();
    vi.mocked(getSetting).mockReset();
    vi.mocked(setSetting).mockReset();
    vi.mocked(deleteSetting).mockReset();
  });

  it("setDomainAndRefreshCache turns the secure-cookie flag on", async () => {
    vi.mocked(setSetting).mockResolvedValue(undefined);
    expect(shouldUseSecureCookies()).toBe(false);
    await setDomainAndRefreshCache("pinchy.example.com");
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("deleteDomainAndRefreshCache turns the secure-cookie flag off", async () => {
    vi.mocked(setSetting).mockResolvedValue(undefined);
    vi.mocked(deleteSetting).mockResolvedValue(undefined);
    await setDomainAndRefreshCache("pinchy.example.com");
    expect(shouldUseSecureCookies()).toBe(true);
    await deleteDomainAndRefreshCache();
    expect(shouldUseSecureCookies()).toBe(false);
  });

  it("loadDomainCache backfills the flag for an already-locked install", async () => {
    vi.mocked(getSetting).mockResolvedValue("pinchy.example.com");
    expect(shouldUseSecureCookies()).toBe(false);
    await loadDomainCache();
    expect(shouldUseSecureCookies()).toBe(true);
  });

  it("loadDomainCache clears a stale flag when no domain is set", async () => {
    vi.mocked(getSetting).mockResolvedValue("pinchy.example.com");
    await loadDomainCache();
    expect(shouldUseSecureCookies()).toBe(true);
    vi.mocked(getSetting).mockResolvedValue(null);
    await loadDomainCache();
    expect(shouldUseSecureCookies()).toBe(false);
  });
});
