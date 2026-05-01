import { describe, it, expect } from "vitest";
import { validatePassword } from "@/lib/validate-password";

describe("validatePassword", () => {
  it("should accept a strong password with 12+ characters, letters, and digits", () => {
    expect(validatePassword("MySecretPass1234")).toBeNull();
  });

  it("should accept passwords with special characters", () => {
    expect(validatePassword("MyS3cret!Pass#")).toBeNull();
  });

  it("should accept exactly 12 characters that meet other criteria", () => {
    expect(validatePassword("Br1ghtNova!2")).toBeNull();
  });

  it("should reject passwords shorter than 12 characters", () => {
    expect(validatePassword("Abc1")).toBe("Password must be at least 12 characters");
  });

  it("should reject 8-character passwords (previous minimum)", () => {
    expect(validatePassword("MySecre1")).toBe("Password must be at least 12 characters");
  });

  it("should reject 11-character passwords", () => {
    expect(validatePassword("password123")).toBe("Password must be at least 12 characters");
  });

  it("should reject empty passwords", () => {
    expect(validatePassword("")).toBe("Password must be at least 12 characters");
  });

  it("should reject passwords without a letter", () => {
    expect(validatePassword("918273645091")).toBe(
      "Password must contain at least one letter and one number"
    );
  });

  it("should reject passwords without a number", () => {
    expect(validatePassword("abcdefghijkl")).toBe(
      "Password must contain at least one letter and one number"
    );
  });

  it("should reject common passwords from the breach-list", () => {
    expect(validatePassword("passwordpassword")).toBe(
      "Password is too common. Please choose a less predictable one."
    );
  });

  it("should reject common passwords case-insensitively", () => {
    expect(validatePassword("PasswordPassword")).toBe(
      "Password is too common. Please choose a less predictable one."
    );
  });

  it("should reject 'password1234' as a common password", () => {
    expect(validatePassword("password1234")).toBe(
      "Password is too common. Please choose a less predictable one."
    );
  });

  it("should reject 'qwertyuiopas' as a common password", () => {
    expect(validatePassword("qwertyuiopas")).toBe(
      "Password is too common. Please choose a less predictable one."
    );
  });

  it("should reject '1q2w3e4r5t6y' as a common password", () => {
    expect(validatePassword("1q2w3e4r5t6y")).toBe(
      "Password is too common. Please choose a less predictable one."
    );
  });
});
