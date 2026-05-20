import { describe, it, expect } from "vitest";
import { sanitizeBundle } from "@/lib/diagnostics/sanitize-bundle";

describe("sanitizeBundle", () => {
  it("redacts sk-ant-* api keys appearing in any string field", () => {
    const dirty = {
      spans: [
        { name: "x", attributes: { foo: "leak sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234 here" } },
      ],
    };
    const clean = sanitizeBundle(dirty);
    expect(JSON.stringify(clean)).not.toContain("sk-ant-api03");
    expect(JSON.stringify(clean)).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const dirty = { spans: [{ attributes: { auth: "Bearer abcdefghijklmnopqrstuvwxyz12" } }] };
    expect(JSON.stringify(sanitizeBundle(dirty))).not.toContain("Bearer abcde");
  });

  it("does not mutate the input", () => {
    const input = {
      spans: [{ attributes: { foo: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234" } }],
    };
    const copy = structuredClone(input);
    sanitizeBundle(input);
    expect(input).toEqual(copy);
  });
});
