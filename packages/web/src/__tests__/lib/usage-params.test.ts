import { describe, it, expect } from "vitest";
import { NextResponse } from "next/server";
import { parseDays } from "@/lib/usage-params";

describe("parseDays", () => {
  it("should default to 30 when param is null", () => {
    expect(parseDays(null)).toBe(30);
  });

  it('should parse "30" as 30', () => {
    expect(parseDays("30")).toBe(30);
  });

  it('should parse "7" as 7', () => {
    expect(parseDays("7")).toBe(7);
  });

  it('should parse "90" as 90', () => {
    expect(parseDays("90")).toBe(90);
  });

  it('should return 0 for "0" (all time)', () => {
    expect(parseDays("0")).toBe(0);
  });

  it('should return 0 for "all" (all time)', () => {
    expect(parseDays("all")).toBe(0);
  });

  it("should return a 400 NextResponse for non-numeric input", () => {
    const result = parseDays("abc");
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it("should return a 400 NextResponse for negative numbers", () => {
    const result = parseDays("-5");
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(400);
  });

  it("should default to 30 for empty string (falsy)", () => {
    expect(parseDays("")).toBe(30);
  });
});
