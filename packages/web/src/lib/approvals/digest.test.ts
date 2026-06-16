import { describe, it, expect } from "vitest";
import { computeArgsDigest } from "./digest";

describe("computeArgsDigest", () => {
  it("is stable regardless of object key order", () => {
    const a = computeArgsDigest({ to: "x@example.com", subject: "Hi" });
    const b = computeArgsDigest({ subject: "Hi", to: "x@example.com" });
    expect(a).toBe(b);
  });

  it("canonicalizes nested objects and arrays", () => {
    const a = computeArgsDigest({ outer: { b: 1, a: 2 }, list: [{ y: 1, x: 2 }] });
    const b = computeArgsDigest({ list: [{ x: 2, y: 1 }], outer: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });

  it("changes when any value changes", () => {
    expect(computeArgsDigest({ id: 1 })).not.toBe(computeArgsDigest({ id: 2 }));
  });

  it("distinguishes array order (semantically significant)", () => {
    expect(computeArgsDigest({ ids: [1, 2] })).not.toBe(computeArgsDigest({ ids: [2, 1] }));
  });

  it("treats null/undefined/empty params as a stable digest", () => {
    const empty = computeArgsDigest({});
    expect(computeArgsDigest(undefined)).toBe(empty);
    expect(computeArgsDigest(null)).toBe(empty);
  });

  it("returns a 64-char hex sha256", () => {
    expect(computeArgsDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
