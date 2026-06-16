import { describe, it, expect } from "vitest";
import { summarizeArgs } from "./summary";

describe("summarizeArgs", () => {
  it("keeps short, non-secret scalar values (informed confirmation)", () => {
    expect(summarizeArgs({ to: "x@example.com", subject: "Invoice" })).toEqual({
      to: "x@example.com",
      subject: "Invoice",
    });
  });

  it("redacts secret-looking keys", () => {
    const out = summarizeArgs({ apiKey: "sk-123", password: "p", auth_token: "t", to: "x@y.z" });
    expect(out.apiKey).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.auth_token).toBe("[redacted]");
    expect(out.to).toBe("x@y.z");
  });

  it("truncates very long strings", () => {
    const out = summarizeArgs({ body: "a".repeat(500) }) as { body: string };
    expect(out.body.endsWith("…")).toBe(true);
    expect(out.body.length).toBeLessThan(210);
  });

  it("collapses nested objects and arrays to a shape hint", () => {
    expect(summarizeArgs({ items: [1, 2, 3], meta: { a: 1, b: 2 } })).toEqual({
      items: "[3 items]",
      meta: "{2 fields}",
    });
  });

  it("returns {} for non-object params", () => {
    expect(summarizeArgs(null)).toEqual({});
    expect(summarizeArgs("nope")).toEqual({});
    expect(summarizeArgs([1, 2])).toEqual({});
  });
});
