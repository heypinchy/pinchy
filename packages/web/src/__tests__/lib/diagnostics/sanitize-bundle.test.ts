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

  it("redacts values under sensitive keys (apikey, password, token, …) regardless of pattern shape", () => {
    const dirty = {
      spans: [
        {
          attributes: {
            // No known secret prefix; would slip past pattern-only redaction.
            apikey: "internal-token-without-prefix-12345",
            // Nested object under a non-sensitive key but containing a sensitive sub-key.
            config: { password: "hunter2", host: "db.example.com" },
          },
        },
      ],
    };
    const clean = sanitizeBundle(dirty);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain("internal-token-without-prefix-12345");
    expect(serialized).not.toContain("hunter2");
    // Non-sensitive values pass through.
    expect(serialized).toContain("db.example.com");
  });

  it("redacts secrets nested at depth (recursive descent works)", () => {
    const dirty = {
      a: { b: { c: { d: "leaked sk-ant-api03-deepdeepdeepdeepdeepdeepdeepd here" } } },
    };
    const clean = sanitizeBundle(dirty);
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain("sk-ant-api03-deepdeep");
    expect(serialized).toContain("[REDACTED]");
  });
});
