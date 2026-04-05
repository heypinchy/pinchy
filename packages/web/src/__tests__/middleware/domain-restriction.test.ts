import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/domain-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain-cache")>();
  return {
    ...actual,
    getCachedDomain: vi.fn(),
  };
});

import { isHostAllowed } from "@/server/host-check";
import { getCachedDomain } from "@/lib/domain-cache";

describe("domain restriction host check", () => {
  beforeEach(() => {
    vi.mocked(getCachedDomain).mockReset();
  });

  it("allows all requests when no domain is cached", () => {
    vi.mocked(getCachedDomain).mockReturnValue(null);
    expect(isHostAllowed("anything.example.com", "/dashboard")).toBe(true);
  });

  it("allows requests when host matches cached domain", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("pinchy.example.com", "/dashboard")).toBe(true);
  });

  it("blocks requests when host does not match cached domain", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("evil.example.com", "/api/settings/domain")).toBe(false);
  });

  it("allows requests when x-forwarded-host matches (caller passes correct header)", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("pinchy.example.com", "/dashboard")).toBe(true);
  });

  it("always allows /api/health regardless of host", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("evil.example.com", "/api/health")).toBe(true);
  });

  it("always allows /api/setup/status regardless of host", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("evil.example.com", "/api/setup/status")).toBe(true);
  });

  it("allows when host has default port 443 and domain does not", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("pinchy.example.com:443", "/dashboard")).toBe(true);
  });

  it("allows when host has default port 80 and domain does not", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("pinchy.example.com:80", "/dashboard")).toBe(true);
  });

  it("blocks when host has non-standard port not matching domain", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed("pinchy.example.com:8443", "/dashboard")).toBe(false);
  });

  it("blocks when host is undefined", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(isHostAllowed(undefined, "/dashboard")).toBe(false);
  });
});
