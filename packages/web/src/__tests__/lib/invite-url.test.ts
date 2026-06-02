import { describe, it, expect } from "vitest";
import { buildInviteUrl } from "@/lib/invite-url";

describe("buildInviteUrl", () => {
  it("builds the invite link from the given origin and token", () => {
    expect(buildInviteUrl("https://pinchy.example.com", "abc123")).toBe(
      "https://pinchy.example.com/invite/abc123"
    );
  });

  it("uses the caller-provided origin verbatim — no base-URL env indirection (#352)", () => {
    // The reset / invite link must reflect the host the admin is actually on
    // (window.location.origin), independent of any configured base URL. This
    // origin-derived construction is precisely why BETTER_AUTH_URL was safe to
    // remove: Pinchy never builds these links from an env var. See #352.
    const origin = "http://localhost:7777";
    expect(buildInviteUrl(origin, "tok")).toBe("http://localhost:7777/invite/tok");
    expect(buildInviteUrl(origin, "tok")).not.toContain("pinchy.example.com");
  });

  it("does not add a trailing slash or duplicate the /invite path segment", () => {
    expect(buildInviteUrl("https://x.test", "t")).toBe("https://x.test/invite/t");
  });
});
