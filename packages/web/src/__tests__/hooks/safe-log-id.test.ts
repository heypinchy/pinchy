/**
 * Unit tests for `safeLogId` — sanitizer applied to server-provided
 * identifiers before they're embedded in client-side log messages.
 *
 * Defends against CodeQL js/log-injection (#310 Tier 2b PR #442 CodeQL
 * finding): a malicious or buggy Pinchy server could put control
 * characters / newlines into a runId, which would fake new log lines or
 * confuse structured-log parsers if logged verbatim.
 */
import { describe, it, expect } from "vitest";
import { safeLogId } from "@/hooks/use-ws-runtime";

describe("safeLogId", () => {
  it("passes a well-formed UUID-style runId through unchanged", () => {
    expect(safeLogId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000"
    );
  });

  it("passes alphanumeric + underscore + dash mixes through unchanged", () => {
    expect(safeLogId("run_abc-123")).toBe("run_abc-123");
  });

  it("rejects strings containing newlines (the classic log-injection vector)", () => {
    expect(safeLogId("legit-id\n[fake-log] admin granted")).toBe("<invalid>");
    expect(safeLogId("legit-id\r\n[crlf injection]")).toBe("<invalid>");
  });

  it("rejects strings containing ANSI escape sequences", () => {
    // Could clear screen / move cursor / hide subsequent log entries in
    // a terminal that renders the output.
    expect(safeLogId("legit\x1b[2J")).toBe("<invalid>");
  });

  it("rejects strings containing whitespace or punctuation outside the allowed set", () => {
    expect(safeLogId("run id with spaces")).toBe("<invalid>");
    expect(safeLogId("run.with.dots")).toBe("<invalid>");
    expect(safeLogId("run/with/slashes")).toBe("<invalid>");
  });

  it("rejects non-string inputs (null, undefined, number, object)", () => {
    expect(safeLogId(null)).toBe("<invalid>");
    expect(safeLogId(undefined)).toBe("<invalid>");
    expect(safeLogId(42)).toBe("<invalid>");
    expect(safeLogId({})).toBe("<invalid>");
  });

  it("rejects the empty string (regex requires at least one char)", () => {
    expect(safeLogId("")).toBe("<invalid>");
  });
});
