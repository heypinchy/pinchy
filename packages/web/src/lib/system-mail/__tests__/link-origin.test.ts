import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/domain-cache", () => ({ getCachedDomain: vi.fn() }));

import { getCachedDomain } from "@/lib/domain-cache";
import { resolveLinkOrigin } from "@/lib/system-mail/link-origin";

function req(headers: Record<string, string>) {
  return new Request("http://pinchy:7777/api/users/invite", { method: "POST", headers });
}

describe("resolveLinkOrigin", () => {
  beforeEach(() => vi.mocked(getCachedDomain).mockReturnValue(null));

  it("uses the locked domain when one is set, regardless of the request's headers", () => {
    vi.mocked(getCachedDomain).mockReturnValue("pinchy.example.com");
    expect(
      resolveLinkOrigin(req({ "x-forwarded-proto": "https", "x-forwarded-host": "evil.test" }))
    ).toBe("https://pinchy.example.com");
  });

  it("otherwise uses the host the admin is browsing, behind a proxy", () => {
    expect(
      resolveLinkOrigin(req({ "x-forwarded-proto": "https", "x-forwarded-host": "pinchy.acme.io" }))
    ).toBe("https://pinchy.acme.io");
  });

  it("falls back to the request URL without a proxy", () => {
    expect(resolveLinkOrigin(req({}))).toBe("http://pinchy:7777");
  });
});
