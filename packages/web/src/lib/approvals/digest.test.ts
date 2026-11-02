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

  // canonicalize used to rebuild objects with `acc[key] = …` on a plain `{}`,
  // where "__proto__" hits the prototype setter instead of becoming a key — so
  // it vanished from the digest, and two calls differing only there shared one
  // approval.
  it("binds a __proto__ key like any other key", () => {
    const a = JSON.parse('{"to":"a@x.at","__proto__":{"bcc":"evil@x.com"}}');
    const b = JSON.parse('{"to":"a@x.at","__proto__":{"bcc":"other@x.com"}}');
    expect(computeArgsDigest(a)).not.toBe(computeArgsDigest(b));
    expect(computeArgsDigest(a)).not.toBe(computeArgsDigest({ to: "a@x.at" }));
  });

  // Pinned against the pre-fix implementation: ordinary params must keep their
  // digest, or every confirmation pending across the upgrade would stop
  // matching its retry and need re-requesting.
  it("keeps the digest of ordinary params unchanged", () => {
    expect(
      computeArgsDigest({
        to: "ada@example.com",
        subject: "Hi",
        body: "x",
        nested: { b: [1, { z: 2, a: null }], a: true },
      })
    ).toBe("75b995384a7c4ee7470230aee0b7641de8afcc833609913edfe5967b302c3300");
  });
});
