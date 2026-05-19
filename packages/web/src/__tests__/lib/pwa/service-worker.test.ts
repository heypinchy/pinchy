import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, join } from "path";

const SW_PATH = join(resolve(__dirname, "../../../../public"), "sw.js");

describe("service worker stub", () => {
  const source = readFileSync(SW_PATH, "utf-8");

  it("calls skipWaiting() on install (so updates activate immediately)", () => {
    expect(source).toMatch(/skipWaiting\s*\(/);
  });

  it("claims clients on activate (so update propagates to open tabs)", () => {
    expect(source).toMatch(/clients\.claim\s*\(/);
  });

  it("registers a fetch listener (required for Chrome installability check)", () => {
    expect(source).toMatch(/addEventListener\s*\(\s*['"]fetch['"]/);
  });
});
