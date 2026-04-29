import { describe, expect, it } from "vitest";
import { isBlocked } from "../blocklist";

describe("isBlocked", () => {
  it("blocks deepseek-r1 when tools capability is required", () => {
    expect(isBlocked("deepseek-r1:32b", ["tools"])).toBe(true);
  });

  it("allows deepseek-r1 without tools requirement", () => {
    expect(isBlocked("deepseek-r1:32b", [])).toBe(false);
  });

  it("allows generic reliable models", () => {
    expect(isBlocked("qwen3:32b", ["tools"])).toBe(false);
  });
});
