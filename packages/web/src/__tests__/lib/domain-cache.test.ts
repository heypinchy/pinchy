import { describe, it, expect } from "vitest";
import { normalizeHost } from "@/lib/domain-cache";

describe("normalizeHost", () => {
  it("should strip port 443", () => {
    expect(normalizeHost("pinchy.example.com:443")).toBe("pinchy.example.com");
  });

  it("should strip port 80", () => {
    expect(normalizeHost("pinchy.example.com:80")).toBe("pinchy.example.com");
  });

  it("should keep non-standard ports", () => {
    expect(normalizeHost("pinchy.example.com:8443")).toBe("pinchy.example.com:8443");
  });

  it("should return host unchanged when no port", () => {
    expect(normalizeHost("pinchy.example.com")).toBe("pinchy.example.com");
  });
});
