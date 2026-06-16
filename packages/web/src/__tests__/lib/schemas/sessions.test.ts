import { describe, it, expect } from "vitest";
import { chatIdSchema } from "@/lib/schemas/sessions";

describe("sessions schemas", () => {
  it("chatIdSchema accepts a nanoid-style id", () => {
    expect(chatIdSchema.parse("v1k2n3p4")).toBe("v1k2n3p4");
  });

  it("chatIdSchema rejects a colon", () => {
    expect(() => chatIdSchema.parse(":")).toThrow();
  });

  it("chatIdSchema rejects a slash", () => {
    expect(() => chatIdSchema.parse("a/b")).toThrow();
  });

  it("chatIdSchema rejects an empty string", () => {
    expect(() => chatIdSchema.parse("")).toThrow();
  });

  it("chatIdSchema rejects an id longer than 64 characters", () => {
    expect(() => chatIdSchema.parse("a".repeat(65))).toThrow();
  });

  it("chatIdSchema accepts an id of exactly 64 characters", () => {
    const id = "a".repeat(64);
    expect(chatIdSchema.parse(id)).toBe(id);
  });

  it("chatIdSchema rejects uppercase letters", () => {
    expect(() => chatIdSchema.parse("ABC")).toThrow();
  });

  it("chatIdSchema rejects spaces", () => {
    expect(() => chatIdSchema.parse("a b")).toThrow();
  });
});
