import { describe, it, expect } from "vitest";

import { deepMerge } from "@/lib/openclaw-config/deep-merge";

describe("deepMerge", () => {
  it("merges disjoint top-level keys", () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("source scalars override target scalars", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it("recursively merges nested plain objects", () => {
    const target = { nested: { keep: 1, override: 2 }, top: "t" };
    const source = { nested: { override: 99, added: 3 } };
    expect(deepMerge(target, source)).toEqual({
      nested: { keep: 1, override: 99, added: 3 },
      top: "t",
    });
  });

  it("replaces arrays wholesale rather than element-merging them", () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it("treats an array in source as a replacement for an object in target", () => {
    expect(deepMerge({ v: { a: 1 } }, { v: [1, 2] })).toEqual({ v: [1, 2] });
  });

  it("treats an object in source as a replacement for an array in target", () => {
    expect(deepMerge({ v: [1, 2] }, { v: { a: 1 } })).toEqual({ v: { a: 1 } });
  });

  it("lets null/undefined source values replace the target value", () => {
    expect(deepMerge({ a: { x: 1 }, b: 2 }, { a: null, b: undefined })).toEqual({
      a: null,
      b: undefined,
    });
  });

  it("does not mutate the target or its nested objects", () => {
    const target = { nested: { a: 1 } };
    const source = { nested: { b: 2 } };
    const result = deepMerge(target, source);
    expect(target).toEqual({ nested: { a: 1 } });
    expect(result.nested).not.toBe(target.nested);
  });

  it("deep-clones the merge path so mutating the result leaves target intact", () => {
    const target = { nested: { a: 1 } };
    const result = deepMerge(target, { nested: { b: 2 } });
    (result.nested as Record<string, unknown>).a = 999;
    expect(target.nested.a).toBe(1);
  });
});
