import { describe, expect, it } from "vitest";
import { sanitize } from "./sanitize";

describe("sanitize", () => {
  it("redacts API key values", () => {
    expect(sanitize({ key: "sk-abc123456789" })).toEqual({ key: "[REDACTED]" });
    expect(sanitize({ key: "sk_live_abc123456789" })).toEqual({ key: "[REDACTED]" });
    expect(sanitize({ key: "api-key123456789" })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts GitHub tokens", () => {
    expect(sanitize({ token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl" })).toEqual({ token: "[REDACTED]" });
  });

  it("redacts npm tokens", () => {
    expect(sanitize({ token: "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" })).toEqual({ token: "[REDACTED]" });
  });

  it("redacts JWTs", () => {
    expect(sanitize({ auth: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" })).toEqual({ auth: "[REDACTED]" });
  });

  it("redacts AWS access keys", () => {
    expect(sanitize({ key: "AKIAIOSFODNN7EXAMPLE" })).toEqual({ key: "[REDACTED]" });
  });

  it("redacts by key name regardless of value", () => {
    expect(sanitize({ api_key: "anything" })).toEqual({ api_key: "[REDACTED]" });
    expect(sanitize({ password: "hunter2" })).toEqual({ password: "[REDACTED]" });
    expect(sanitize({ secret_key: "myval" })).toEqual({ secret_key: "[REDACTED]" });
    expect(sanitize({ Authorization: "Basic abc" })).toEqual({ Authorization: "[REDACTED]" });
    expect(sanitize({ database_url: "postgres://..." })).toEqual({ database_url: "[REDACTED]" });
    expect(sanitize({ openai_api_key: "sk-..." })).toEqual({ openai_api_key: "[REDACTED]" });
  });

  it("preserves non-sensitive data", () => {
    expect(sanitize({ path: "/data/file.md", count: 42 })).toEqual({ path: "/data/file.md", count: 42 });
  });

  it("handles nested objects", () => {
    expect(sanitize({ config: { api_key: "secret", name: "test" } })).toEqual({
      config: { api_key: "[REDACTED]", name: "test" },
    });
  });

  it("handles arrays", () => {
    expect(sanitize({ items: ["normal", "sk-secret123456789"] })).toEqual({
      items: ["normal", "[REDACTED]"],
    });
  });

  it("handles null and undefined", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
    expect(sanitize({ key: null })).toEqual({ key: null });
  });

  it("handles deeply nested data without crashing", () => {
    let obj: any = { value: "safe" };
    for (let i = 0; i < 15; i++) {
      obj = { nested: obj };
    }
    // Should not throw, deep values become [REDACTED]
    expect(() => sanitize(obj)).not.toThrow();
  });

  it("redacts long hex strings (likely tokens)", () => {
    expect(sanitize({ hash: "abcdef1234567890abcdef1234567890abcdef1234" })).toEqual({ hash: "[REDACTED]" });
  });

  it("does not redact short strings", () => {
    expect(sanitize({ name: "hello" })).toEqual({ name: "hello" });
    expect(sanitize({ id: "abc123" })).toEqual({ id: "abc123" });
  });
});
