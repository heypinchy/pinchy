import { describe, it, expect } from "vitest";
import { validatePassword } from "@/lib/validate-password";

describe("validatePassword", () => {
  it("should accept a strong password", () => {
    expect(validatePassword("MySecret1")).toBeNull();
  });

  it("should reject passwords shorter than 8 characters", () => {
    expect(validatePassword("Abc1")).toBe("Password must be at least 8 characters");
  });

  it("should reject empty passwords", () => {
    expect(validatePassword("")).toBe("Password must be at least 8 characters");
  });

  it("should reject passwords without a letter", () => {
    expect(validatePassword("12345678")).toBe(
      "Password must contain at least one letter and one number"
    );
  });

  it("should reject passwords without a number", () => {
    expect(validatePassword("abcdefgh")).toBe(
      "Password must contain at least one letter and one number"
    );
  });

  it("should accept passwords with special characters", () => {
    expect(validatePassword("MyP@ss1!")).toBeNull();
  });
});
