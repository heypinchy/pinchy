import { describe, it, expect } from "vitest";
import { isSafeReturnTo, buildLoginRedirectPath } from "@/lib/return-to";

describe("isSafeReturnTo", () => {
  it.each([
    ["/share?share_id=abc", true],
    ["/agents", true],
    ["/chat/x?keep", true],
    ["//evil.com", false],
    ["https://evil.com", false],
    ["javascript:alert(1)", false],
    ["/\\evil.com", false],
    ["\\\\evil.com", false],
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
