import { describe, it, expect } from "vitest";
import { directoryKey, isSameDirectory, sameDirectorySet } from "@/lib/directory-path";

describe("directory-path", () => {
  it("treats a trailing slash as the same directory", () => {
    expect(isSameDirectory("/data/x/", "/data/x")).toBe(true);
    expect(isSameDirectory("/data/x//", "/data/x")).toBe(true);
  });

  it("does not treat a prefix as the same directory", () => {
    expect(isSameDirectory("/data/x", "/data/xy")).toBe(false);
    expect(isSameDirectory("/data/x/", "/data/x/y")).toBe(false);
  });

  it("keeps the root as the root", () => {
    expect(directoryKey("/")).toBe("/");
  });

  it("compares grant lists as sets of directories", () => {
    expect(sameDirectorySet(["/data/a/", "/data/b/"], ["/data/b", "/data/a"])).toBe(true);
    expect(sameDirectorySet(["/data/a/", "/data/a"], ["/data/a"])).toBe(true);
    expect(sameDirectorySet(["/data/a/"], [])).toBe(false);
    expect(sameDirectorySet(["/data/a/"], ["/data/b"])).toBe(false);
  });
});
