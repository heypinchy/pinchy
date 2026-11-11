import { describe, it, expect, vi, beforeEach } from "vitest";

// The domain lock is read from the database, not the in-memory domain cache:
// route bundles load src/lib as a second module instance whose cache is never
// filled at boot, so a cache read there says "no lock" on every locked install.
vi.mock("@/lib/domain", () => ({ getDomain: vi.fn() }));

import { getDomain } from "@/lib/domain";
import { resolveLinkOrigin } from "@/lib/system-mail/link-origin";

function req(headers: Record<string, string>) {
  return new Request("http://pinchy:7777/api/users/invite", { method: "POST", headers });
}

describe("resolveLinkOrigin", () => {
  beforeEach(() => vi.mocked(getDomain).mockResolvedValue(null));

  it("uses the locked domain when one is set, regardless of the request's headers", async () => {
    vi.mocked(getDomain).mockResolvedValue("pinchy.example.com");
    expect(
      await resolveLinkOrigin(
        req({ "x-forwarded-proto": "https", "x-forwarded-host": "evil.test" })
      )
    ).toBe("https://pinchy.example.com");
  });

  it("otherwise uses the host the admin is browsing, behind a proxy", async () => {
    expect(
      await resolveLinkOrigin(
        req({ "x-forwarded-proto": "https", "x-forwarded-host": "pinchy.acme.io" })
      )
    ).toBe("https://pinchy.acme.io");
  });

  it("takes the public hop of a multi-hop forwarded host (CDN in front of Caddy)", async () => {
    expect(
      await resolveLinkOrigin(
        req({
          "x-forwarded-proto": "https, http",
          "x-forwarded-host": "pinchy.acme.io, caddy:443",
        })
      )
    ).toBe("https://pinchy.acme.io");
  });

  it("falls back to the request URL without a proxy", async () => {
    expect(await resolveLinkOrigin(req({}))).toBe("http://pinchy:7777");
  });

  it("falls back to the request URL when the forwarded host isn't a usable host", async () => {
    expect(
      await resolveLinkOrigin(req({ "x-forwarded-proto": "https", "x-forwarded-host": "a b" }))
    ).toBe("http://pinchy:7777");
  });
});
