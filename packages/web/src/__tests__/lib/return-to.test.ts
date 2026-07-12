import { describe, it, expect } from "vitest";
import { isSafeReturnTo, buildLoginRedirectPath } from "@/lib/return-to";

describe("isSafeReturnTo", () => {
  it.each([
    ["/share?share_id=abc", true],
    ["/share?share_id=abc#frag", true],
    ["/agents", true],
    ["/chat/x?keep", true],
    ["//evil.com", false],
    ["https://evil.com", false],
    ["javascript:alert(1)", false],
    ["/\\evil.com", false],
    ["\\\\evil.com", false],
    // Control chars (tab/CR/LF) are stripped by WHATWG URL parsing, which
    // can merge a later "/" into the leading position and change the
    // origin — e.g. new URL("/\t/evil.com", base).origin becomes
    // https://evil.com. A parse-based guard must reject these.
    ["/\t/evil.com", false],
    ["/\n/evil.com", false],
    ["/\r/evil.com", false],
    ["/\t/evil", false],
    // Encoded double-slash: stays same-origin but is suspicious path
    // traversal shaping; the parse-based guard rejects it.
    ["/%2F%2Fevil.com", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("isSafeReturnTo(%j) -> %s", (value, expected) => {
    expect(isSafeReturnTo(value)).toBe(expected);
  });
});

describe("buildLoginRedirectPath", () => {
  it("encodes a safe destination into the returnTo query param", () => {
    expect(buildLoginRedirectPath("/share?share_id=abc")).toBe(
      "/login?returnTo=%2Fshare%3Fshare_id%3Dabc"
    );
  });

  it("falls back to / when the destination is missing", () => {
    expect(buildLoginRedirectPath(null)).toBe("/login?returnTo=%2F");
    expect(buildLoginRedirectPath(undefined)).toBe("/login?returnTo=%2F");
  });

  it("falls back to / when the destination is unsafe", () => {
    expect(buildLoginRedirectPath("//evil.com")).toBe("/login?returnTo=%2F");
    expect(buildLoginRedirectPath("https://evil.com")).toBe("/login?returnTo=%2F");
  });
});
